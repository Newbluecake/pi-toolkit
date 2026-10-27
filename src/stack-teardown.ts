/**
 * Stack teardown — ONE place that says which component is torn down, on which entry, in which order
 * (#56 ⑦ step 7-2; docs/dev/source-governance/batch2-plan.md §4).
 *
 * A session stack is torn down through three different entries; each has its own ordered step list below.
 * The lists are deliberately NOT merged into one: the orders differ on purpose (see the "why this order" notes)
 * and so do the member sets. A component that is missing from a list is a known gap (`GAP-Gn`, matrix test
 * tests/integration/stack-teardown-matrix.test.ts pins every one of them); 7b fixes them one per commit.
 *
 *  - `rebuild-handoff` (path A): the top of the NEXT `buildSessionStack` in the SAME module. Works on the previous
 *    build's `TeardownParts` — including components that are not `Stack` members (usage broadcaster, coalescers,
 *    the bash job manager). pi 1.3 reaches it for same-cwd new/resume/fork; /reload and cross-cwd resume re-import
 *    the module, so `previousParts` starts empty there and path C is the only teardown.
 *  - `defensive` (path B): index.ts's session_start when the activation already holds a stack (a second
 *    session_start without a shutdown — unreachable in pi 1.3, kept as a guard). Works on the `Stack`.
 *  - `shutdown` (path C4): index.ts's session_shutdown main handler, awaited by pi. Works on the `Stack`.
 *    (C1 — the synchronous, early-registered xs part — is `Stack.disposeXsSync`; C2/C3 are separate handlers in
 *    their own modules. Their registration order relative to the other plugins' handlers is pinned by the
 *    activation-trace golden, so they are not folded into this table.)
 *
 * Every step is idempotent in the component it calls; the same component may legitimately be reached by C and A.
 * Sync steps run synchronously (an exception propagates out of the entry), and the shutdown runner only awaits a
 * step that actually returned a promise — so this refactor adds no microtask hop the inline code did not have.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { killBashJobsBounded } from "./bash/host.js";
import type { BashJobManager } from "./bash/manager.js";
import type { ArchiveControl } from "./archive/control.js";
import type { CacheKeepaliveService } from "./cache-ttl/keepalive-service.js";
import type { AgentSettings } from "./config/settings.js";
import type { Coalescer } from "./delivery/coalescer.js";
import type { UsageBroadcaster } from "./delivery/usage-broadcast.js";
import type { BackgroundCompletionHub } from "./service/background-completions.js";
import type { createFabricMailbox } from "./fabric/mailbox.js";
import type { RootWakeController } from "./fabric/root-wake.js";
import type { StackXs } from "./fabric/xs/stack.js";
import type { QuotaStack } from "./quota/index.js";
import type { Stack } from "./stack.js";
import type { FleetWidgetController } from "./ui/fleet-widget.js";
import type { BackgroundWorkflows } from "./workflow/background.js";

/** Which door the teardown came through. */
export type StackTeardownEntry =
  | { kind: "rebuild-handoff" }
  | {
      kind: "defensive";
      /** the NEW session's xs identity: a different one proves the old session ended */ nextXsSessionId?:
        string | undefined;
    }
  | { kind: "shutdown"; reason: string };

/**
 * Activate-level pieces that sit BETWEEN stack steps (they do not belong to any stack). Built by index.ts through
 * `createActivationTeardown` (src/activation-teardown.ts) and handed in through the env, so each step keeps its
 * original position in the order.
 */
export interface ActivationTeardown {
  /** B: xs ledger teardown when the next session id differs (`xs.defensiveTeardown`). */
  defensiveXsTeardown(nextXsSessionId: string | undefined): void;
  /** C4-2: status bar cleared + digest disposed BEFORE the schedule executor closes its runs. */
  scheduleSurfaceShutdown(): void;
  /** C4-23: only on a real quit — bounded best-effort seal/kill of every child session's bash jobs. */
  sealChildBashJobs(): Promise<void>;
}

export interface StackTeardownEnv {
  /** The event's ctx (`dynamic.dispose` flushes its telemetry window through it). */
  readonly ctx: ExtensionContext;
  readonly settings: AgentSettings;
  readonly activation: ActivationTeardown;
}

/**
 * Everything one build owns that some teardown path must reach. Written INCREMENTALLY, at the very places the
 * original `previousX = x` assignments were, so a build that throws half-way leaves exactly the already-created
 * components for the next build's handoff (a single end-of-build write would change that).
 */
export interface TeardownParts {
  /** Same-module defensive rebuild; a fresh-module reload is disposed by `Stack.disposeXsSync`. */
  xs?: StackXs | undefined;
  rootWakeRecovery?: RootWakeController | undefined;
  /** Disposed FIRST (ask-user-async §3.3): a completion flushed by the old coalescer/bash manager's own dispose must
   *  not broadcast to the new session's ask_user. */
  backgroundCompletions?: BackgroundCompletionHub | undefined;
  /** X7b: stop the old widget's 1 Hz tick + `setWidget(key, undefined)` before the new one mounts. */
  fleetWidget?: FleetWidgetController | undefined;
  /** M-E: not a `Stack` member (GAP-G1: path C never reaches it). */
  usageBroadcaster?: UsageBroadcaster | undefined;
  /** Not `Stack` members (GAP-G2/G3: path C never reaches them). `dispose()` flushes what is buffered. */
  coalescer?: Coalescer | undefined;
  ackHold?: Coalescer | undefined;
  /** §3.6/§3.7: `dispose()` only clears timers — it never kills a process and never notifies afterwards, so the next
   *  stack's `recover()` can adopt the still-running jobs; the live `LocalHandle`s are handed to the new manager. */
  bashJobs?: BashJobManager | undefined;
  /** A stale control's auto-sweep would `appendEntry` the OLD session's archive state into the NEW session's file. */
  archive?: ArchiveControl | undefined;
  /** bash-timeout-grace P5: aborts whichever recovery/cleanup phase is still outstanding. */
  bashJobRecovery?: { dispose(): void } | undefined;
  fabricMailbox?: ReturnType<typeof createFabricMailbox> | undefined;
  /** cache-ttl keepalive (plan §2.2); `isCurrent` reads this slot, so clearing it supersedes the old service. */
  keepalive?: CacheKeepaliveService | undefined;
  /** quota-plan §4.1: `QuotaService.dispose` is the single idempotent owner. */
  quota?: QuotaStack | undefined;
  /** Background workflows: the defensive handoff — stop everything, report nothing (primary teardown is `shutdown`). */
  workflowRuns?: BackgroundWorkflows | undefined;
  /** workflow-worktree D13: spawn-service + runtime-adapter pair. */
  worktreeLate?: { dispose(): void } | undefined;
  /** workflow-worktree §3 (P4): flips the startup orphan scan's `live` flag so a late scan never notifies. */
  worktreeOrphansStartup?: { dispose(): void } | undefined;
  /** child-bash no-host-view diag: ref-counted on the registry side, release is idempotent. */
  hostBashViewRelease?: (() => void) | undefined;
  /** external-agent §5.5 (P5): stops the directory probe; never kills a running run. */
  external?: { dispose(): void } | undefined;
}

/** What path A hands to the new build: the previous bash manager (captured BEFORE its dispose) for `handoffInProcess`. */
export interface RebuildHandoff {
  prevBashJobs?: BashJobManager | undefined;
}

interface RebuildStep {
  readonly id: string;
  run(parts: TeardownParts, handoff: RebuildHandoff): void;
}
interface StackStep<Result extends void | Promise<void>> {
  readonly id: string;
  run(stack: Stack, env: StackTeardownEnv, entry: StackTeardownEntry): Result;
}

/** `parts.x?.dispose(); parts.x = undefined` — the original two-line pattern, one slot at a time. */
function rebuildDispose<K extends keyof TeardownParts>(id: string, key: K): RebuildStep {
  return {
    id,
    run(parts) {
      (parts[key] as { dispose(): void } | undefined)?.dispose();
      parts[key] = undefined;
    },
  };
}

// ───────────────────────────── path A — rebuild-handoff (order = §4.2 column A) ─────────────────────────────
const REBUILD_STEPS: readonly RebuildStep[] = [
  rebuildDispose("xs", "xs"),
  rebuildDispose("rootWakeRecovery", "rootWakeRecovery"),
  rebuildDispose("backgroundCompletions", "backgroundCompletions"),
  rebuildDispose("fleetWidget", "fleetWidget"),
  rebuildDispose("usageBroadcaster", "usageBroadcaster"),
  rebuildDispose("coalescer", "coalescer"),
  rebuildDispose("ackHold", "ackHold"),
  {
    // §3.6/§3.7: capture before dispose so in-process jobs can transfer their live LocalHandle to the new manager;
    // dispose keeps those handles alive.
    id: "bashJobs",
    run(parts, handoff) {
      handoff.prevBashJobs = parts.bashJobs;
      parts.bashJobs?.dispose();
      parts.bashJobs = undefined;
    },
  },
  rebuildDispose("archive", "archive"),
  rebuildDispose("bashJobRecovery", "bashJobRecovery"),
  rebuildDispose("fabricMailbox", "fabricMailbox"),
  rebuildDispose("keepalive", "keepalive"),
  rebuildDispose("quota", "quota"),
  {
    id: "workflowRuns",
    run(parts) {
      parts.workflowRuns?.abandon();
      parts.workflowRuns = undefined;
    },
  },
  rebuildDispose("worktreeLate", "worktreeLate"),
  rebuildDispose("worktreeOrphansStartup", "worktreeOrphansStartup"),
  {
    id: "hostBashViewCapability",
    run(parts) {
      parts.hostBashViewRelease?.();
      parts.hostBashViewRelease = undefined;
    },
  },
  rebuildDispose("external", "external"),
];

/** Path A. Mutates `parts` (each slot cleared right after its step) and returns what the new build must adopt. */
export function runRebuildHandoff(parts: TeardownParts): RebuildHandoff {
  const handoff: RebuildHandoff = {};
  for (const step of REBUILD_STEPS) step.run(parts, handoff);
  return handoff;
}

// ───────────────────────────── path B — defensive (order = §4.2 column B) ─────────────────────────────
const DEFENSIVE_STEPS: readonly StackStep<void>[] = [
  // ask-user-async §3.3 (P2): stop the old hub's broadcast FIRST so a completion flushed by the teardown below can
  // never reach the new session's ask_user (idempotent; shutdown is the other path).
  { id: "xs", run: (stack) => void stack.xs?.dispose() },
  { id: "rootWakeRecovery", run: (stack) => void stack.rootWakeRecovery?.dispose() },
  {
    // Defensive replacement without shutdown: a NEW identity proves the old session ended. Same-session reload is
    // deliberately not proof.
    id: "xsLedger",
    run: (_stack, env, entry) =>
      env.activation.defensiveXsTeardown(entry.kind === "defensive" ? entry.nextXsSessionId : undefined),
  },
  { id: "backgroundCompletions", run: (stack) => void stack.backgroundCompletions.dispose() },
  { id: "fleetWidget", run: (stack) => void stack.fleetWidget?.dispose() },
  // web-hub archive plan: stop the stale auto-sweep (dual-path with buildSessionStack).
  { id: "archive", run: (stack) => void stack.archive?.dispose() },
  { id: "keepalive", run: (stack) => void stack.keepalive?.dispose() },
  { id: "quota", run: (stack) => void stack.quota?.dispose() },
  // external-agent plan §5.5 (P5): stop the directory probe (double insurance with the /reload rebuild).
  { id: "external", run: (stack) => void stack.external?.dispose() },
  // P1-4: defensive cleanup (idempotent with shutdown).
  { id: "dynamic", run: (stack, env) => void stack.dynamic?.dispose(env.ctx) },
  { id: "load", run: (stack) => void stack.load?.dispose() },
  // defensive: the next stack recovers this epoch's runs (unknown(reload)) — dispose only, no closeEpoch.
  { id: "schedule", run: (stack) => void stack.schedule?.dispose() },
  { id: "scheduleBackground", run: (stack) => void stack.scheduleBackground?.dispose() },
  { id: "rpc", run: (stack) => void stack.rpc.close() },
  { id: "fabric", run: (stack) => void stack.fabric?.dispose() },
  // stop orphaned background workflows; their notices are dropped
  { id: "workflowRuns", run: (stack) => void stack.workflow.runs.abandon() },
  // GAP-G5: bashJobRecovery · GAP-G6: worktreeLate / worktreeOrphansStartup / hostBashViewCapability —
  // absent here (preserved; path B is unreachable in pi 1.3, so they are optional to fix).
];

// ───────────────────────────── path C4 — shutdown (order = §4.2 column C4) ─────────────────────────────
const SHUTDOWN_STEPS: readonly StackStep<void | Promise<void>>[] = [
  // ask-user-async §3.3 (P2): FIRST — the hub stops broadcasting before the drain/seal below settles anything;
  // completions surfacing during shutdown must not interrupt whatever session comes next.
  { id: "backgroundCompletions", run: (stack) => void stack.backgroundCompletions.dispose() },
  // scheduled-reports A0 (§4.6): the schedule executor goes FIRST — dispose, then this epoch's non-terminal runs
  // become unknown(owner-closed) (lock wait ≤ 500 ms) BEFORE the run drain below can land a shutdown `aborted`
  // (first terminal write wins).
  { id: "scheduleSurface", run: (_stack, env) => void env.activation.scheduleSurfaceShutdown() },
  { id: "schedule", run: (stack) => stack.schedule?.shutdown() },
  // AFTER closeEpoch wrote unknown(owner-closed): late outcomes only append lateOutcome.
  { id: "scheduleBackground", run: (stack) => void stack.scheduleBackground?.dispose() },
  // X7b: kill the fleet widget unconditionally. /reload re-imports this extension as a fresh module, so the module-level
  // handoff never sees the pre-reload controller, and its self-rescheduling 1 Hz tick would outlive the session forever.
  { id: "fleetWidget", run: (stack) => void stack.fleetWidget?.dispose() },
  { id: "archive", run: (stack) => void stack.archive?.dispose() }, // same fresh-module /reload rationale as the widget
  { id: "keepalive", run: (stack) => void stack.keepalive?.dispose() },
  { id: "quota", run: (stack) => void stack.quota?.dispose() },
  // P1-4: flush the telemetry window + persist estimates (T-D3-DISPOSE).
  { id: "dynamic", run: (stack, env) => void stack.dynamic?.dispose(env.ctx) },
  { id: "load", run: (stack) => void stack.load?.dispose() },
  { id: "rpc", run: (stack) => void stack.rpc.close() }, // X8
  // bash-timeout-grace P5: abort whichever recovery/cleanup phase this stack still has outstanding — covers the
  // fresh-module /reload case.
  { id: "bashJobRecovery", run: (stack) => void stack.bashJobRecovery?.dispose() },
  // Fabric must freeze before run shutdown so late verdicts from the old stack cannot write into the shared outbox; the
  // next stack owns pending records. (Also disposes the wake service through the mailbox — closes G12.)
  { id: "fabric", run: (stack) => void stack.fabric?.dispose() },
  {
    // C4-14…18, one unit because `pending`/`drainMs` flow through it:
    //  shutdown (request a stop on every running workflow first, so no script spawns another child)
    //  → spawn.abort(pending) (also covers a just-admitted, not-yet-entered resume the runtime adapter does not know yet;
    //    admitted-run-visibility fix, 2026-10-08 incident)
    //  → query.waitAll ∥ workflow drain (one shared bound)
    //  → runJournal.flushPending (synchronous, best effort, into THIS session while pi has not invalidated the ctx;
    //    run-persistence plan D5)
    //  → workflow seal (finalizes any workflow still settling with its degraded snapshot; its notice is persisted into
    //    THIS session while it is still current).
    id: "runDrain",
    async run(stack, env, entry) {
      const reason = entry.kind === "shutdown" ? entry.reason : "";
      const drainMs = Math.min(env.settings.budget.abortGraceMs * 3, 15_000);
      stack.workflow.runs.shutdown();
      const pending = stack.query
        .list()
        .filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
      await Promise.all(pending.map((s) => stack.spawn.abort(s.runId, "shutdown")));
      await Promise.all([
        stack.query.waitAll({ runIds: pending.map((s) => s.runId), waitMs: drainMs }),
        stack.workflow.runs.drain(drainMs),
      ]);
      stack.runJournal.flushPending(
        pending.map((s) => s.runId),
        reason,
      );
      stack.workflow.runs.seal();
    },
  },
  // workflow-worktree D13: after seal() — any run this stack is still settling gets its chance to write through the
  // normal path first; only truly late reports after this point are redirected.
  { id: "worktreeLate", run: (stack) => void stack.worktreeLate?.dispose() },
  // workflow-worktree §3 (P4): a scan still resolving when the session ends must never surface a stale prompt.
  { id: "worktreeOrphansStartup", run: (stack) => void stack.worktreeOrphansStartup?.dispose() },
  // child-bash no-host-view diag: idempotent, so this and the next build's own top-of-build release never double-release.
  { id: "hostBashViewCapability", run: (stack) => void stack.hostBashViewCapability.dispose() },
  {
    // bash auto-background §3.7: reload/new/resume/fork always keep the processes (the next stack adopts them); only a
    // real `quit` consults shutdownPolicy, and even `kill` is bounded best-effort — a background job that refuses to die
    // must never delay pi's exit.
    id: "bashKill",
    async run(stack, env, entry) {
      if (
        stack.bashJobs &&
        entry.kind === "shutdown" &&
        entry.reason === "quit" &&
        env.settings.bashJobs.shutdownPolicy === "kill"
      ) {
        await killBashJobsBounded(stack.bashJobs, env.settings.budget.abortGraceMs);
      }
    },
  },
  // bash-timeout-grace §3.3 S6: same "only a real quit" gate as the main session's own jobs above — a child subagent that is
  // STILL RUNNING when the main session merely `/reload`s must keep its background jobs.
  {
    id: "childBashSeal",
    run: (_stack, env, entry) =>
      entry.kind === "shutdown" && entry.reason === "quit" ? env.activation.sealChildBashJobs() : undefined,
  },
  // GAP-G1 usageBroadcaster · GAP-G2 coalescer · GAP-G3 ackHold · GAP-G4 bashJobs manager · GAP-G7 external:
  // not reachable from the Stack (path A only).
];

/** Path B (sync) and path C4 (async). Path A is `runRebuildHandoff` over the parts. */
export function runStackTeardown(
  entry: { kind: "defensive"; nextXsSessionId?: string | undefined },
  stack: Stack,
  env: StackTeardownEnv,
): void;
export function runStackTeardown(
  entry: { kind: "shutdown"; reason: string },
  stack: Stack,
  env: StackTeardownEnv,
): Promise<void>;
export function runStackTeardown(entry: StackTeardownEntry, stack: Stack, env: StackTeardownEnv): void | Promise<void> {
  if (entry.kind === "defensive") {
    for (const step of DEFENSIVE_STEPS) step.run(stack, env, entry);
    return;
  }
  if (entry.kind === "shutdown") return runShutdown(entry, stack, env);
  throw new Error("runStackTeardown: use runRebuildHandoff for the rebuild-handoff entry");
}

async function runShutdown(entry: StackTeardownEntry, stack: Stack, env: StackTeardownEnv): Promise<void> {
  for (const step of SHUTDOWN_STEPS) {
    const pending = step.run(stack, env, entry);
    if (pending !== undefined) await pending;
  }
}

/** C1's synchronous subset (kept separate: registered early, must run in pi's synchronous phase). */
export function disposeXsSync(stack: Stack): void {
  stack.xs?.fence.onEvent({ type: "session_shutdown" });
  stack.xs?.dispose();
  stack.rootWakeRecovery?.dispose();
}
