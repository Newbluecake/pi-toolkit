/**
 * Scheduled tasks — agent-side assembly (plan r3 §3, §3.3, §4.6, §7.6, §10.3, §12 A0).
 *
 * Two levels, mirroring the rest of the toolkit (src/index.ts invariant I7 — assembly only there):
 *
 *  - `wireSchedule(pi, opts)` — once per `activate()`, post-guard (main session only), and ONLY when
 *    `schedule.enabled` (default off ⇒ never called ⇒ zero surface). Resolves the store dir, builds
 *    the process-level hub router (when web-hub is on and the domain is plain), registers the one
 *    `turn_start` hook (rev poke through the late-bound current agent).
 *  - `ScheduleWiring.createAgent(...)` — once per session stack (`buildSessionStack`). Resolves the
 *    §3.3 run mode, the holder identity / epoch, the lazy store, the SessionClock (interactive
 *    only), the session coordinator (Hub or Null) and the executor registry that A1 (background)
 *    and A2 (message dispatcher) fill in.
 *
 * Nothing touches disk until needed: the store root is resolved read-only and lazily (created only
 * by `ensureStore()` — A3's create path — or when the hub needs `HubConfig.schedule.dir`).
 * The old global engine (`src/schedule/{scheduler,store,cron}.ts`, `~/.pi/agent/pi-subagent-schedules.json`)
 * is retired: never read, never written (A0-report §迁移).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock, type Clock } from "../../core/clock.js";
import type { ScheduleSettings } from "../../config/settings.js";
import { legacyConsultForkDir } from "../../runtime/legacy-consult-forks.js";
import { canonicalPath, inVaultDir, type SecureDomain } from "../../secure/domain.js";
import { SCHED_TOLERANCE_S, type HubScheduleConfig } from "../../web-hub/protocol/schedule.js";
import { closeEpoch, manualClaim, type ClaimGate } from "../core/claim.js";
import { SCHED_LOCK_SHUTDOWN_TIMEOUT_MS } from "../core/lock.js";
import { resolveStoreRoot, SchedFsError, type InVaultPredicate, type StoreRoot } from "../core/paths.js";
import { readSessionStateById, type SessionStateRead } from "../core/reader.js";
import { holderOf, readSelfIdentity, type ProcessIdentity } from "../core/recovery.js";
import { defHash, type Holder, type RunRecord, type ScheduleForm, type ScheduleTask } from "../core/spec.js";
import {
  ensureStoreRoot,
  finishRun,
  openSessionStore,
  removePendingReports,
  type SessionStore,
} from "../core/writer.js";
import { createSessionClock, type SessionClock } from "./clock.js";
import {
  createHubCoordinator,
  createScheduleHubRouter,
  NULL_SCHEDULE_COORDINATOR,
  type ScheduleCoordinator,
  type ScheduleHubRouter,
  type ScheduleWebHubPort,
  type SchedRunVerdict,
} from "./coordinator.js";
import type { MessageSchedulerInstall } from "./message.js";
import { assertExecutable, resolveScheduleMode, type ScheduleModeVerdict, type ScheduleRefusal } from "./mode.js";

// ----------------------------------------------------------------- disposed epochs (process-wide)

/**
 * Epochs this process KNOWS were disposed (`recoverRuns` may turn their runs into unknown(reload)).
 * Process-global on `Symbol.for` (the one sanctioned exception to "no module state": it must outlive
 * /reload's fresh module instance, worktree-origin precedent), FIFO-capped.
 */
const EPOCHS_KEY = Symbol.for("pi-subagent:sched-disposed-epochs");
export const SCHED_DISPOSED_EPOCHS_MAX = 256;

function epochSet(): Set<string> {
  const g = globalThis as Record<symbol, unknown>;
  let s = g[EPOCHS_KEY] as Set<string> | undefined;
  if (!(s instanceof Set)) {
    s = new Set<string>();
    g[EPOCHS_KEY] = s;
  }
  return s;
}

export function markEpochDisposed(epoch: string): void {
  const s = epochSet();
  s.delete(epoch);
  s.add(epoch);
  while (s.size > SCHED_DISPOSED_EPOCHS_MAX) {
    const first = s.values().next().value;
    if (first === undefined) break;
    s.delete(first);
  }
}

export function isEpochDisposed(epoch: string): boolean {
  return epochSet().has(epoch);
}

export function newEpoch(): string {
  return randomBytes(8).toString("hex");
}

// ----------------------------------------------------------------- helpers

export function resolveScheduleDir(settings: Pick<ScheduleSettings, "dir">, agentDir: string): string {
  return settings.dir ?? join(agentDir, "schedules");
}

/** Vault predicate over every registered vault (literal AND canonical form, §11). */
export function vaultPredicateOf(domain: Pick<SecureDomain, "vaults"> | undefined): InVaultPredicate {
  const vaults = domain?.vaults ?? [];
  if (vaults.length === 0) return () => false;
  return (p: string) => {
    const c = canonicalPath(p);
    return vaults.some((v) => inVaultDir(c, v) || inVaultDir(p, v));
  };
}

/** `subagent:child` self-marker (line 2 of a child session) — in-memory entries, no IO. */
export function hasChildMarker(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
  try {
    const entries = (ctx.sessionManager as { getEntries?: () => unknown[] }).getEntries?.() ?? [];
    for (let i = 0; i < Math.min(entries.length, 8); i++) {
      const e = entries[i] as { type?: unknown; customType?: unknown } | undefined;
      if (e?.type === "custom" && e.customType === "subagent:child") return true;
    }
  } catch {
    /* stale ctx ⇒ not provably a child */
  }
  return false;
}

function isUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function sessionIdOf(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  try {
    const id = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.();
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function sessionFileOf(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  try {
    const f = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.();
    return typeof f === "string" && f !== "" ? f : undefined;
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- executors (A1 / A2 extension point)

/**
 * A1 (`bg.ts`) and A2 (`dispatch.ts`) register here. `dispatch` is called OUTSIDE the lock right
 * after a successful claim (auto `fired` or manual `started`, never on a replay); it must not throw
 * and from then on owns the run's terminal write (S1 `finishRun` / `writeReportLocked`).
 */
export interface ScheduleExecutor {
  dispatch(run: RunRecord, task: ScheduleTask): void;
}

export type ScheduleRunNowResult =
  { kind: "started"; runKey: string; replay: boolean } | { kind: "refused"; code: string; detail?: string };

export interface ScheduleAgent {
  readonly mode: ScheduleModeVerdict;
  /** Owner sid (undefined only for a session without an id — then nothing can execute). */
  readonly sessionId: string | undefined;
  readonly epoch: string;
  /** undefined ⇔ /proc unavailable (Linux-only identity) ⇒ no execution. */
  readonly holder: Holder | undefined;
  readonly self: ProcessIdentity | undefined;
  readonly dir: string;
  readonly coordinator: ScheduleCoordinator;
  readonly clock: SessionClock | undefined;
  /** Store when the root exists (lazy, read-only resolve); undefined otherwise or when not plain. */
  store(): SessionStore | undefined;
  /** Create the store root if needed (A3's create path). Throws `SchedFsError` / Error on refusal. */
  ensureStore(): SessionStore;
  /** Read-only view of this session's ledger (every mode; never creates anything). */
  readState(): SessionStateRead;
  /** Unified execution gate (§7.6); with a task also checks ownerCwd and the executor for its form. */
  gate(task?: ScheduleTask): ScheduleRefusal | undefined;
  setExecutor(form: ScheduleForm, executor: ScheduleExecutor | undefined): void;
  /** §4.5b manual run (sched_run, tool run_now, /schedule run): claim + executor hand-off. */
  runNow(req: { taskId: string; reqId: string; defHash?: string }): Promise<ScheduleRunNowResult>;
  /** A local ledger write happened (A1/A2/A3): notify the hub and re-check the clock. */
  changed(): void;
  /** Interactive only: first sweep + recovery + arm. Never throws. */
  start(): Promise<void>;
  /** turn_start: cheap rev check. */
  poke(): void;
  /** session_shutdown FIRST step: dispose, then close this epoch's runs as unknown(owner-closed) (≤ 500 ms lock). */
  shutdown(): Promise<void>;
  /** Synchronous dispose (defensive rebuild path); marks the epoch disposed. Idempotent. */
  dispose(): void;
  isDisposed(): boolean;
}

export interface ScheduleWireOpts {
  settings: ScheduleSettings;
  agentDir: string;
  /** Frozen domain verdict of this process. */
  secure: SecureDomain;
  /** Runtime LOCKED reason (secure guards), re-read at every execution point. */
  lockedReason?: () => string | undefined;
  /** webHub.enabled ∧ control !== false: build the hub router (only in the plain domain). */
  webHub: boolean;
  /** Late-bound current session agent (holder.current?.schedule). */
  current: () => ScheduleAgent | undefined;
  clock?: Clock;
  warn?: (message: string) => void;
  /** Tests: identity / flock probes. */
  readSelf?: () => ProcessIdentity | undefined;
  flockProbe?: () => boolean;
}

export interface CreateAgentInput {
  ctx: ExtensionContext;
}

export interface ScheduleWiring {
  readonly dir: string;
  /** `WebHubDeps.schedule` — present ⇔ webHub ∧ plain domain. */
  readonly webHubPort: ScheduleWebHubPort | undefined;
  readonly router: ScheduleHubRouter | undefined;
  /** I1: the activate-level A2 installer (`src/index.ts` sets it; `buildSessionStack` attaches each agent to it). */
  readonly message?: MessageSchedulerInstall;
  createAgent(input: CreateAgentInput): ScheduleAgent;
}

export function defaultFlockProbe(): boolean {
  try {
    const r = spawnSync("flock", ["-V"], { stdio: "ignore", timeout: 2_000 });
    return r.error === undefined && r.status === 0;
  } catch {
    return false;
  }
}

export function wireSchedule(pi: Pick<ExtensionAPI, "on">, opts: ScheduleWireOpts): ScheduleWiring {
  const warn = opts.warn ?? ((m: string) => console.warn(`[pi-subagent] schedule: ${m}`));
  const dir = resolveScheduleDir(opts.settings, opts.agentDir);
  const plain = opts.secure.kind === "plain";
  const inVault = vaultPredicateOf(opts.secure);
  const warned = new Set<string>();
  const warnOnce = (key: string, m: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(m);
  };
  let flockOk: boolean | undefined;

  const hubConfig = (): HubScheduleConfig | undefined => {
    try {
      // The hub pins the root at start (resolveStoreRoot): it must exist ⇒ create it here (0700).
      const root = ensureStoreRoot(dir, { inVault });
      return { dir: root.real, toleranceS: SCHED_TOLERANCE_S };
    } catch (err) {
      warnOnce(
        "hubcfg",
        `store dir unusable, HubConfig.schedule omitted: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  };
  const router = opts.webHub && plain ? createScheduleHubRouter({ hubConfig }) : undefined;

  pi.on("turn_start", () => {
    opts.current()?.poke();
  });

  return {
    dir,
    webHubPort: router,
    router,
    createAgent({ ctx }) {
      const sessionId = sessionIdOf(ctx);
      const sessionFile = sessionFileOf(ctx);
      let childFile = hasChildMarker(ctx);
      if (!childFile && sessionFile !== undefined) {
        try {
          childFile = isUnder(sessionFile, legacyConsultForkDir());
        } catch {
          /* no agent dir ⇒ not a consult fork */
        }
      }
      const mode = resolveScheduleMode({
        mode: (ctx as { mode?: string }).mode ?? "print",
        sessionFile,
        childFile,
        secure: opts.secure.kind,
      });
      const self = plain ? (opts.readSelf ?? readSelfIdentity)() : undefined;
      if (plain && self === undefined) warnOnce("proc", "no /proc identity: scheduled tasks cannot execute here");
      if (mode.arm && flockOk === undefined) {
        flockOk = (opts.flockProbe ?? defaultFlockProbe)();
        if (!flockOk)
          warnOnce("flock", "util-linux `flock` not found: every schedule transaction fails closed (E_BUSY)");
      }
      return createScheduleAgent({
        ctx,
        mode,
        sessionId,
        self,
        dir,
        plain,
        inVault,
        clock: opts.clock ?? systemClock,
        warn,
        router,
        ...(opts.lockedReason !== undefined ? { lockedReason: opts.lockedReason } : {}),
      });
    },
  };
}

// ----------------------------------------------------------------- per-session agent

export interface ScheduleAgentDeps {
  ctx: Pick<ExtensionContext, "sessionManager">;
  mode: ScheduleModeVerdict;
  sessionId: string | undefined;
  self: ProcessIdentity | undefined;
  dir: string;
  plain: boolean;
  inVault: InVaultPredicate;
  clock: Clock;
  monotonic?: () => number;
  warn: (message: string) => void;
  router: ScheduleHubRouter | undefined;
  lockedReason?: () => string | undefined;
  /** Store test hooks (lock timeout / flock binary). */
  storeOpts?: { flockBin?: string; lockTimeoutMs?: number };
}

export function createScheduleAgent(deps: ScheduleAgentDeps): ScheduleAgent {
  const epoch = newEpoch();
  const holder = deps.self !== undefined ? holderOf(deps.self, epoch) : undefined;
  let disposed = false;
  const executors: Partial<Record<ScheduleForm, ScheduleExecutor>> = {};
  let root: StoreRoot | undefined;
  let store: SessionStore | undefined;
  let rootTried = -Infinity;
  const ROOT_RETRY_MS = 30_000;

  const buildStore = (r: StoreRoot, lockTimeoutMs?: number): SessionStore =>
    openSessionStore({
      root: r,
      sessionId: deps.sessionId!,
      self: deps.self!,
      epoch,
      inVault: deps.inVault,
      now: () => deps.clock.now(),
      ...(deps.monotonic !== undefined ? { monotonic: deps.monotonic } : {}),
      ...(deps.storeOpts?.flockBin !== undefined ? { flockBin: deps.storeOpts.flockBin } : {}),
      ...(lockTimeoutMs !== undefined
        ? { lockTimeoutMs }
        : deps.storeOpts?.lockTimeoutMs !== undefined
          ? { lockTimeoutMs: deps.storeOpts.lockTimeoutMs }
          : {}),
    });

  const canStore = (): boolean => deps.plain && deps.sessionId !== undefined && deps.self !== undefined;

  const getStore = (): SessionStore | undefined => {
    if (store !== undefined) return store;
    if (!canStore()) return undefined;
    const now = deps.clock.now();
    if (now - rootTried < ROOT_RETRY_MS) return undefined;
    rootTried = now;
    try {
      root = resolveStoreRoot(deps.dir, { inVault: deps.inVault });
    } catch (err) {
      if (!(err instanceof SchedFsError && err.reason === "missing"))
        deps.warn(`store dir unusable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    store = buildStore(root);
    return store;
  };

  const ports = {
    verdict: deps.mode,
    ownerSessionId: deps.sessionId ?? "",
    currentSessionId: () => sessionIdOf(deps.ctx),
    disposed: () => disposed,
    ...(deps.lockedReason !== undefined ? { lockedReason: deps.lockedReason } : {}),
    inVault: deps.inVault,
  };

  const gateNoTask = (): ScheduleRefusal | undefined => {
    // Matrix / disposal / lock refusals first (E_SECURE, E_MODE, …), then identity, then owner.
    if (disposed || deps.mode.kind !== "interactive") return assertExecutable(ports);
    if (holder === undefined || deps.sessionId === undefined)
      return { code: "E_UNSUPPORTED", detail: "no process identity / session id" };
    return assertExecutable(ports);
  };
  const claimGate: ClaimGate = () => gateNoTask();

  const gate = (task?: ScheduleTask): ScheduleRefusal | undefined => {
    const g = gateNoTask();
    if (g !== undefined || task === undefined) return g;
    if (executors[task.form] === undefined)
      return { code: "E_UNSUPPORTED", detail: `no executor for ${task.form} tasks in this build` };
    return assertExecutable(ports, task);
  };

  let coordinator: ScheduleCoordinator = NULL_SCHEDULE_COORDINATOR;
  let detach: (() => void) | undefined;

  const changed = (): void => {
    coordinator.changed();
  };

  /** Terminal write for a claimed run that has no executor (never left dispatching/queued). */
  const strand = async (run: RunRecord, reason: string): Promise<void> => {
    const s = getStore();
    if (s === undefined) return;
    const r = await s.transact((draft, ctx) => {
      const out =
        run.form === "background"
          ? finishRun(draft, run.runKey, { state: "refused", reason: `admission:${reason}` }, ctx.now)
          : finishRun(draft, run.runKey, { state: "dropped", reason: "capability" }, ctx.now);
      return { value: out, write: out === "ok" };
    });
    if (r.ok && r.wrote) changed();
  };

  const dispatchRun = (run: RunRecord, task: ScheduleTask): void => {
    if (disposed) return; // closeEpoch turns it into unknown(owner-closed)
    const exec = executors[run.form];
    if (exec === undefined) {
      void strand(run, "E_UNSUPPORTED");
      return;
    }
    try {
      exec.dispatch(run, task);
    } catch (err) {
      deps.warn(`executor threw for ${run.runKey}: ${err instanceof Error ? err.message : String(err)}`);
      void strand(run, "executor-error");
    }
  };

  const clock =
    deps.mode.arm && canStore()
      ? createSessionClock({
          store: { get: getStore },
          holder: holder!,
          self: deps.self!,
          armedSince: deps.clock.now(),
          clock: deps.clock,
          ...(deps.monotonic !== undefined ? { monotonic: deps.monotonic } : {}),
          gate: claimGate,
          preflight: (task) => gate(task),
          judge: { currentEpoch: epoch, epochDisposed: isEpochDisposed },
          onFired: dispatchRun,
          onChanged: changed,
          warn: deps.warn,
        })
      : undefined;

  if (deps.router !== undefined && deps.mode.kind === "interactive" && deps.sessionId !== undefined) {
    const router = deps.router;
    coordinator = createHubCoordinator({
      link: () => router.link(),
      sessionId: deps.sessionId,
      now: () => deps.clock.now(),
      runRequest: async (req) => {
        const r = await agent.runNow(req);
        return r.kind === "started"
          ? ({ result: "started" } as SchedRunVerdict)
          : ({ result: "refused", reason: r.code } as SchedRunVerdict);
      },
      removeReports: async (ids) => {
        const s = getStore();
        if (s === undefined) return true; // nothing to remove
        const r = await s.transact((draft) => {
          const n = removePendingReports(draft, ids);
          return { value: n, write: n > 0 };
        });
        if (!r.ok) return false;
        if (r.wrote) changed();
        return true;
      },
      retryLater: (fn) => {
        deps.clock.setTimer(5_000, fn);
      },
      warn: deps.warn,
    });
    detach = router.attach(coordinator);
  }

  const agent: ScheduleAgent = {
    mode: deps.mode,
    sessionId: deps.sessionId,
    epoch,
    holder,
    self: deps.self,
    dir: deps.dir,
    get coordinator() {
      return coordinator;
    },
    clock,
    store: getStore,
    ensureStore() {
      if (store !== undefined) return store;
      if (!canStore()) throw new Error("schedule store unavailable in this session");
      root = ensureStoreRoot(deps.dir, { inVault: deps.inVault });
      store = buildStore(root);
      return store;
    },
    readState() {
      if (!deps.plain || deps.sessionId === undefined) return { kind: "absent" };
      try {
        const r = root ?? resolveStoreRoot(deps.dir, { inVault: deps.inVault });
        return readSessionStateById(r, deps.sessionId, { inVault: deps.inVault });
      } catch (err) {
        if (err instanceof SchedFsError && err.reason === "missing") return { kind: "absent" };
        return {
          kind: "degraded",
          reason: err instanceof SchedFsError ? err.reason : "io",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
    gate,
    setExecutor(form, executor) {
      if (executor === undefined) delete executors[form];
      else executors[form] = executor;
    },
    async runNow(req) {
      const pre = gateNoTask();
      if (pre !== undefined) return { kind: "refused", code: pre.code, detail: pre.detail };
      const s = getStore();
      if (s === undefined) return { kind: "refused", code: "E_INVALID", detail: "no such task" };
      const snap = s.read();
      const task = snap.kind === "ok" ? snap.state.tasks.find((t) => t.id === req.taskId) : undefined;
      if (task !== undefined) {
        const g = gate(task);
        if (g !== undefined) return { kind: "refused", code: g.code, detail: g.detail };
      }
      const r = await manualClaim(s, {
        taskId: req.taskId,
        reqId: req.reqId,
        ...(req.defHash !== undefined ? { defHash: req.defHash } : {}),
        holder: holder!,
        gate: claimGate,
      });
      switch (r.kind) {
        case "started": {
          if (!r.replay) {
            changed();
            const claimed = r.run;
            if (claimed !== undefined) {
              // Dispatch with the definition the claim actually bound (run.defHash), never a stale snapshot.
              const now = s.read();
              const bound = now.kind === "ok" ? now.state.tasks.find((t) => t.id === req.taskId) : undefined;
              if (bound !== undefined && defHash(bound) === claimed.defHash) dispatchRun(claimed, bound);
              else void strand(claimed, "E_REV");
            }
          }
          return { kind: "started", runKey: r.runKey, replay: r.replay };
        }
        case "refused":
          if (!r.replay) changed();
          return { kind: "refused", code: r.code };
        case "error":
          return { kind: "refused", code: r.code, detail: r.detail };
      }
    },
    changed() {
      changed();
      clock?.poke();
    },
    async start() {
      if (disposed || clock === undefined) return;
      try {
        await clock.start();
      } catch (err) {
        deps.warn(`clock start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    poke() {
      clock?.poke();
    },
    async shutdown() {
      const wasDisposed = disposed;
      agent.dispose();
      if (wasDisposed || holder === undefined || store === undefined || root === undefined) return;
      try {
        const s = buildStore(root, SCHED_LOCK_SHUTDOWN_TIMEOUT_MS);
        const r = await closeEpoch(s, holder);
        if (r.kind === "error" && r.code !== "E_BUSY") deps.warn(`closeEpoch: ${r.code} ${r.detail}`);
      } catch (err) {
        deps.warn(`closeEpoch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      markEpochDisposed(epoch);
      clock?.dispose();
      coordinator.dispose();
      detach?.();
      detach = undefined;
    },
    isDisposed: () => disposed,
  };
  return agent;
}
