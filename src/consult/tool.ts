import { existsSync, statSync } from "node:fs";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AnchorIdentity,
  ConsultCacheDiagnostics,
  ConsultExpertRef,
  ConsultThreadRef,
  ConsultWarmPrediction,
  ErrorInfo,
  ExpertRequestSnapshot,
  RunDiagnostics,
  ForkExpertSessionResult,
  RunId,
  RunOutcome,
  RunSnapshot,
  SpawnRequest,
} from "../core/types.js";
import type { ConsultSettings } from "../config/settings.js";
import {
  CONSULT_NOT_IN_WHITELIST_MARK,
  CONSULT_OUTCOMES,
  classifyConsultCacheResult,
} from "../core/consult-summary.js";
import type { QueryService } from "../service/query-service.js";
import type { SpawnService } from "../service/spawn-service.js";
import { toPiToolUsage } from "../tools/usage.js";
import { truncateResultText } from "../tools/result-text.js";
import { buildConsultPrompt, consultPromptLists } from "./prompt.js";
import type { ExpertSnapshotScanResult } from "./fork-store.js";
import type { ConsultCacheProbe } from "../core/consult-summary.js";
import type { ConsultGuardCounters } from "../core/types.js";
import {
  compareRecordedPrefix,
  getPrefixProbeRegistry,
  type PrefixProbeRegistry,
  type RunPrefixRecord,
} from "./prefix-probe.js";
import { getConsultGuard } from "./preserve-guard.js";
import { createCapWatcher, type ConsultCapReason } from "./watcher.js";
import type { MainSessionFacts, MainSessionFactsProvider } from "./main-facts.js";
import type { ConsultThreads, ThreadHead, ThreadLease, ThreadReason } from "./threads.js";
import { snapDigestOf, type AnchorLedger } from "./anchor-ledger.js";
import type { AnchorObservation } from "./anchor.js";

/**
 * "consult" — in-turn synchronous ask of a finished expert run
 * (docs/dev/consult/plan.md §4.1). Forks the expert's persisted session
 * read-only, asks one question, and returns the answer inside this tool
 * call.
 *
 * Error contract (§4.1 error table): **throw** only when the asking model
 * itself is wrong (expert not in this run's whitelist, empty question) —
 * everything else is a normal tool result (nack) so a consult attempt can
 * never fail the asking run's turn.
 */

/** Schema carries only the two model-facing fields — all caps live in settings (review-1 #20). */
export const ConsultToolParams = Type.Object({
  expert: Type.String({
    description:
      "Which expert to consult: a label or run_id from this run's expert whitelist (resolved and validated at " +
      "dispatch time). The expert must be a FINISHED subagent run; consult forks its persisted session and asks " +
      "your question. The consulted copy runs in YOUR checkout with read-only tools (read/grep/find/ls). There is " +
      "no fallback to a fresh agent — if the expert is unavailable you get a clear negative answer and should " +
      "investigate yourself.",
  }),
  question: Type.String({
    description:
      "The question, self-contained. The expert sees its own history plus this question (nothing from your session). " +
      "Consecutive consults of the same expert from this run form a thread: the expert also sees your earlier " +
      "questions and its full answers (the first line of each result says exactly what it saw).",
  }),
  fresh: Type.Optional(
    Type.Boolean({
      description:
        "Set true to drop this run's thread with the expert and ask from the expert's original session " +
        "(earlier consult Q/A are not seen and not retained). Default false.",
    }),
  ),
});
export type ConsultToolParams = Static<typeof ConsultToolParams>;

/**
 * consult (plan §4.1, review-2 #1): the narrow spawn port the consult tool
 * is allowed to use. Deliberately NOT `NestedSpawnPort` — giving the nested
 * Agent tool a `waitOutcome` would let it ack arbitrary runs' outcomes
 * (X3 minimal privilege). Constructed by `wireConsult` from the real
 * SpawnService; `waitOutcome`/`abortRun`/`watchRun` only accept runIds this
 * port itself spawned (the owned set), everything else rejects/no-ops.
 */
export interface ConsultSpawnPort {
  /** Passthrough of SpawnService.spawn; the port asserts `expectAck === true && forkSessionFrom !== undefined`. */
  spawn(req: SpawnRequest): Promise<{ runId: RunId; label?: string } | { error: ErrorInfo }>;
  /**
   * = SpawnService.waitOutcome(runId) with NO waitMs (no timer — the run's
   * totalMs hard cap guarantees settlement; already-settled runs return
   * immediately, so a reap racing the wait is not a loss).
   */
  waitOutcome(runId: RunId): Promise<RunOutcome>;
  /**
   * Abort a capped consult run. Internally `SpawnService.abort(runId,
   * "user_stop")` — `StopCause` stays closed at five values (§15 #1), so the
   * fleet row / `diag.stopCause` will read user_stop; the real reason lives
   * in the watcher's `capReason` and `details.outcome`. Fire-and-forget.
   */
  abortRun(runId: RunId, reason: ConsultCapReason): void;
  /** Subscribe to run snapshots (stack onSnapshot → wireConsult.dispatchSnapshot). */
  watchRun(runId: RunId, cb: (snapshot: RunSnapshot) => void): () => void;
}

/**
 * The fork-store surface the consult tool needs (plan §3 deps). Implemented
 * by `src/consult/fork-store.ts` (package B) and injected by stack wiring;
 * keeping it an interface lets package C compile and test standalone.
 */
export interface ConsultForkStore {
  /**
   * Synchronous expert-session fork; NEVER throws (§15 #2 — failures fold
   * into `{ok:false,reason}`). `opts.forceCwd` (workflow-worktree plan §2
   * D10): the isolated-asker path — the fork's file-header cwd is forced to
   * `fallbackCwd` (the asker's own worktree) instead of the usual two-level
   * resolution against the expert's original header cwd.
   */
  forkExpertSession(sourceFile: string, fallbackCwd: string, opts?: { forceCwd?: boolean }): ForkExpertSessionResult;
  /**
   * consult (plan §16 rule 5): consistency-checked variant used ONLY for
   * the host main session — unlike a terminal expert's file, main's can be
   * concurrently appended to (or wholesale rewritten by pi's own
   * `_rewriteFile`) at the exact moment `consult("main", …)` runs.
   * Optional: falls back to `forkExpertSession` when a fork store does not
   * provide it (e.g. package C unit tests with a plain stub). `opts.forceCwd`
   * mirrors `forkExpertSession`'s (workflow-worktree plan §2 D10).
   */
  forkMainSession?(sourceFile: string, fallbackCwd: string, opts?: { forceCwd?: boolean }): ForkExpertSessionResult;
  /** Delete a fork file; must be consult-dir-scoped and ENOENT-silent (idempotent). */
  removeForkFile(path: string): void;
  /**
   * Two-level cwd resolution for the consult spawn (expert header cwd if it
   * still exists, else the asker's cwd — §5.1). Optional: when absent the
   * spawn request falls back to the asker's cwd.
   */
  resolveForkCwd?(sourceFile: string, fallbackCwd: string): string;
  /** Optional (package B): TTL + broken-header sweep of the fork dir; stack calls it at build time. */
  sweepForkDir?(): void;
  /** C2 loadout scan. A missing/invalid loadout must refuse before spawn. */
  scanExpertSnapshot(forkFile: string): ExpertSnapshotScanResult;
}

/** Per-asker + global concurrency gate (wireConsult closure, plan §4.1 ②). */
export interface ConsultInflight {
  tryAcquire(selfRunId: RunId): boolean;
  release(selfRunId: RunId): void;
}

/**
 * Construct the narrow port over a real SpawnService (plan §4.1, review-2
 * #1). `owned`/`watchers` are the caller's (wireConsult's) closure state so
 * the same sets drive `dispatchSnapshot` — exported separately for direct
 * unit testing of the owned-runId semantics (T-5).
 */
export function createConsultSpawnPort(deps: {
  spawnService: Pick<SpawnService, "spawn" | "waitOutcome" | "abort">;
  /** runIds spawned through this port (waitOutcome/abortRun/watchRun serve only these). */
  owned: Set<RunId>;
  /** runId → subscribed snapshot callbacks (fed by wireConsult.dispatchSnapshot). */
  watchers: Map<RunId, Set<(snapshot: RunSnapshot) => void>>;
}): ConsultSpawnPort {
  const { spawnService, owned, watchers } = deps;
  return {
    async spawn(req) {
      // Port contract: consult spawns are always ack'd fork runs.
      if (req.expectAck !== true || req.forkSessionFrom === undefined) {
        return {
          error: {
            kind: "config",
            message: "consult spawn port requires expectAck:true and forkSessionFrom",
            retryable: false,
          },
        };
      }
      let started: Awaited<ReturnType<SpawnService["spawn"]>>;
      try {
        started = await spawnService.spawn(req);
      } catch (e) {
        return { error: { kind: "config", message: e instanceof Error ? e.message : String(e), retryable: false } };
      }
      if ("error" in started) return started;
      owned.add(started.runId);
      return started;
    },
    async waitOutcome(runId) {
      if (!owned.has(runId)) throw new Error(`consult port: run ${runId} was not spawned through this port`);
      // No waitMs → no timer: the run's totalMs hard cap (budgetOverride)
      // guarantees settlement; an already-settled run returns immediately
      // (so a reap racing the wait is not a loss, §4.1 ⑧).
      const result = await spawnService.waitOutcome(runId);
      if (result.kind !== "settled") throw new Error(`consult port: run ${runId} unexpectedly pending`);
      owned.delete(runId);
      return result.outcome;
    },
    abortRun(runId, _reason) {
      if (!owned.has(runId)) return; // no-op for foreign/finished runs
      // §15 #1: StopCause stays closed — the real reason (turn_cap/cost_cap)
      // travels only in capReason / details.outcome, never in StopCause.
      void spawnService.abort(runId, "user_stop");
    },
    watchRun(runId, cb) {
      if (!owned.has(runId)) return () => undefined;
      let set = watchers.get(runId);
      if (set === undefined) {
        set = new Set();
        watchers.set(runId, set);
      }
      set.add(cb);
      const registered = set;
      return () => {
        registered.delete(cb);
        if (registered.size === 0 && watchers.get(runId) === registered) watchers.delete(runId);
      };
    },
  };
}

/** Internal constants (deliberately NOT settings — review-1 #20 anti-knob-creep). */
/** Context pre-check threshold: at ≥75% a consult would likely trigger compaction (5min budget ≫ 150s). */
export const CONSULT_MAX_CONTEXT_PERCENT = 75;
/** Global in-flight cap across all askers (slotless runs bypass the slot pool; review-2 #15②). */
export const CONSULT_MAX_GLOBAL_INFLIGHT = 8;

/**
 * The asking run's cwd cell (workflow-worktree plan §2 D10). `isolated` is
 * true only when the asker is a worktree-isolated run whose worktree has
 * actually been created (H2 succeeded and gave it a different cwd) — an
 * unisolated asker, or one whose H2 never ran/failed, always reads
 * `isolated:false`.
 */
export interface ConsultAskerCwd {
  readonly cwd: string;
  readonly isolated: boolean;
}

export interface ConsultDeps {
  /** The asking run's id — parentRunId of the consult run and the concurrency key. */
  selfRunId: RunId;
  /**
   * Getter for the asker's cwd cell (workflow-worktree plan §2 D10). A
   * getter, not a plain string, because the runtime adapter writes this
   * cell once AFTER H2 resolves — by the time this tool's `execute()` ever
   * runs the session already exists, which is always after H2, so every
   * call observes the settled value. Read EXACTLY ONCE per `execute()` call
   * (into a local snapshot) — never re-invoked mid-call.
   */
  selfCwd: () => ConsultAskerCwd;
  /** Dispatch-time resolved expert whitelist (SpawnRequest.consultExperts — trusted). */
  whitelist: readonly ConsultExpertRef[];
  port: ConsultSpawnPort;
  /** Live state/terminal snapshots (liveness re-check + freshest contextUsage). */
  query: QueryService;
  /** Reload-proof settledAt fallback from ExpertIndex. */
  expertSettledAt?: (runId: RunId) => number | undefined;
  /** Optional registry seam for deterministic probe tests; production uses the process registry. */
  prefixProbeRegistry?: PrefixProbeRegistry;
  forkStore: ConsultForkStore;
  /**
   * Model unit prices ($/M tok) with `ModelCost.tiers` selection already
   * applied by the caller (stack.ts narrows pi's Model, review-3 #7).
   * Unknown model → undefined → cost pre-check skipped.
   */
  priceOf: (
    model: { provider: string; id: string },
    contextTokens: number,
  ) => { input: number; cacheWrite: number } | undefined;
  inflight: ConsultInflight;
  settings: () => ConsultSettings;
  /**
   * consult (plan §16): live host-session facts, read fresh on every
   * `consult("main", …)` call (never the dispatch-time ref snapshot — rule
   * 3/4). Absent + a "main" ref in the whitelist ⇒ every consult of it nacks
   * with "no persisted session" (safe default; wireConsult always injects
   * the real provider in production).
   */
  mainSessionFacts?: MainSessionFactsProvider;
  /** cache-thread plan §4: follow-up thread registry (wireConsult closure). Absent ⇒ legacy one-shot consults. */
  threads?: ConsultThreads;
  /** cache-thread plan §5.1: proven-touch ledger used for the pre-consult warm/cold prediction. */
  anchorLedger?: AnchorLedger;
  /** Trusted anchor observation of a consult run (default: the process prefix-probe record). */
  anchorOf?: (consultRunId: RunId) => AnchorObservation | undefined;
  /** pi-ai api of a model route (prediction needs `anthropic-messages`); absent ⇒ prediction `unknown`. */
  routeApi?: (model: { provider: string; id: string }) => string | undefined;
  /** Take-once per-fork display metadata handed to the runtime adapter (enqueue meta; Q1 ruling). */
  displayMeta?: {
    put(forkPath: string, meta: ConsultDisplayMeta): void;
    drop(forkPath: string): void;
  };
  /** Time source (tests); default Date.now. */
  now?: () => number;
}

/** What the adapter folds into the consult run's own diag at enqueue (A's frozen RunDisplayMeta fields). */
export interface ConsultDisplayMeta {
  consultCache: Pick<ConsultCacheDiagnostics, "v" | "predicted">;
  consultThread?: ConsultThreadRef;
}

/** `details.outcome` vocabulary of the consult tool result (§4.1 error table). */
/**
 * consult A/B instrumentation plan (§5 P1b): derived from core's frozen
 * `CONSULT_OUTCOMES` so the tool's own outcome vocabulary and the diag-side
 * classifier (`classifyConsultToolEnd`) can never drift apart. The
 * type-equality assertion below locks the derived union to the exact frozen
 * vocabulary (including the C2 failure outcomes). It stays a plain string
 * union — every `details.outcome` written by the tool is one of these literals.
 */
export type ConsultOutcome = (typeof CONSULT_OUTCOMES)[number];
/** Compile-time lock: the derived union is exactly the frozen literal union (both directions). */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _consultOutcomeUnchanged: SameUnion<
  ConsultOutcome,
  | "completed"
  | "unavailable"
  | "still_running"
  | "busy"
  | "context_too_large"
  | "cost_too_high"
  | "timeout"
  | "turn_cap"
  | "cost_cap"
  | "failed"
  | "aborted"
  | "identity_mismatch"
  | "guard_unavailable"
  | "blocked_cap"
> = true;
void _consultOutcomeUnchanged;

export interface ConsultToolDetails {
  expertRunId?: string;
  expertLabel?: string;
  consultRunId?: string;
  model?: string;
  costUsd?: number;
  /** First-request estimate (fork-path prefix rewrite at write price); absent when tokens/price unknown. */
  costEstimateUsd?: number;
  /** ≈ how many first-request-sized turns remain under maxCostUsd (§15 #4). */
  turnBudgetHint?: number;
  truncated?: boolean;
  partial?: boolean;
  durationMs?: number;
  turns?: number;
  toolCounts?: Record<string, number>;
  outcome: ConsultOutcome;
  /** Spawn admission error text (details.configError, §4.1 error table last row). */
  configError?: string;
  /** Internal diagnostic payload folded by the host consult summary reducer. */
  cacheProbe?: ConsultCacheProbe;
}

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);

function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function randomBase36(length: number): string {
  let s = "";
  while (s.length < length) s += Math.random().toString(36).slice(2);
  return s.slice(0, length);
}

/** Longest expert slug kept in a consult run label (fleet rows stay one line). */
const CONSULT_LABEL_EXPERT_MAX = 32;

/** Label-safe form of an expert name: `[A-Za-z0-9._-]` only, runs of anything else → one `-`, capped. */
function consultLabelSlug(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CONSULT_LABEL_EXPERT_MAX)
    .replace(/-+$/, "");
}

/**
 * `consult-<expert>-<rand4>` — the expert slug says who is being asked; the
 * random base36 suffix (review-1 #11) keeps high-frequency consults from ever
 * exhausting the label space. An empty slug falls back to `consult-<rand4>`.
 */
export function consultRunLabel(expert?: string): string {
  const slug = expert !== undefined ? consultLabelSlug(expert) : "";
  return slug !== "" ? `consult-${slug}-${randomBase36(4)}` : `consult-${randomBase36(4)}`;
}

function describeWhitelist(whitelist: readonly ConsultExpertRef[]): string {
  return whitelist
    .map((ref) =>
      ref.label !== undefined && ref.label !== "" && ref.label !== ref.runId
        ? `${ref.label} (${ref.runId})`
        : ref.runId,
    )
    .join(", ");
}

/** `label (r_xxx)` suffix, the exact display format `describeWhitelist`/`renderExpertRoster` show the model. */
const PAREN_SUFFIX_RE = /^(.*\S)\s*\(([^()]+)\)\s*$/;

/** Exact runId → exact label (unique) → unique runId prefix. `undefined` when `candidate` matches nothing. */
function resolveExpertRef(candidate: string, whitelist: readonly ConsultExpertRef[]): ConsultExpertRef | undefined {
  if (candidate.length === 0) return undefined;
  const byExactId = whitelist.find((ref) => ref.runId === candidate);
  if (byExactId) return byExactId;
  const byLabel = whitelist.filter((ref) => ref.label === candidate);
  if (byLabel.length === 1 && byLabel[0]) return byLabel[0];
  const byPrefix = whitelist.filter((ref) => ref.runId.startsWith(candidate));
  if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0];
  return undefined;
}

/**
 * Match `expert` against the run's whitelist: exact runId → exact label →
 * unique runId prefix (§4.1 ①). Also accepts the `label (r_xxx)` display
 * format the tool's own whitelist description (`describeWhitelist`/
 * `renderExpertRoster`) shows the model — observed in production, the model
 * copies that string verbatim (eval-2026-10.md §4 tool-friction). When the
 * handle has that shape, the run id inside the parentheses is preferred;
 * the label before it is a fallback only (defensive — should always agree).
 * Anything else is the asker's own mistake → throw, same precedent as
 * Agent's allowedTypes check.
 */
export function matchExpertRef(handle: string, whitelist: readonly ConsultExpertRef[]): ConsultExpertRef {
  const trimmed = handle.trim();
  const direct = resolveExpertRef(trimmed, whitelist);
  if (direct) return direct;
  const paren = PAREN_SUFFIX_RE.exec(trimmed);
  if (paren) {
    const [, labelPart, idPart] = paren;
    const byParenId = resolveExpertRef(idPart!.trim(), whitelist);
    if (byParenId) return byParenId;
    const byParenLabel = resolveExpertRef(labelPart!.trim(), whitelist);
    if (byParenLabel) return byParenLabel;
  }
  throw new Error(
    // consult A/B instrumentation plan (§5 P1b): the message references
    // core's CONSULT_NOT_IN_WHITELIST_MARK so `classifyConsultToolEnd`'s
    // bad_ref detection (substring match on the thrown text) and this throw
    // can never drift. Byte-identical to the pre-P1b literal.
    `consult: expert "${handle}" ${CONSULT_NOT_IN_WHITELIST_MARK} (allowed: ${describeWhitelist(whitelist)}). ` +
      "Ask your dispatcher to add it, or answer from your own context.",
  );
}

function outcomeLabel(outcome: RunOutcome, capReason: ConsultCapReason | undefined): ConsultOutcome {
  if (outcome.status === "aborted" && capReason !== undefined) return capReason; // §15 #1: real reason over user_stop
  if (outcome.status === "timed_out") return "timeout";
  return outcome.status; // completed | failed | aborted
}

/**
 * State the real cause and the real elapsed time (eval-2026-10.md §4
 * tool-friction: a turn-cap cutoff at ~20s was reported as "did not answer
 * within 150s", citing the configured budget instead of what actually
 * happened). `outcome.durationMs` is the run's real wall-clock duration —
 * never the configured timeout/cap, which may never have been reached.
 */
function humanReason(
  outcome: RunOutcome,
  capReason: ConsultCapReason | undefined,
  caps: Pick<ConsultSettings, "maxTurns" | "maxCostUsd">,
): string {
  const elapsedS = Math.round(outcome.durationMs / 1000);
  switch (outcome.status) {
    case "timed_out":
      return `wall-clock timeout after ${elapsedS}s`;
    case "aborted":
      if (capReason === "turn_cap") return `turn cap reached (${caps.maxTurns} turns) after ${elapsedS}s`;
      if (capReason === "cost_cap") return `cost cap reached ($${caps.maxCostUsd}) after ${elapsedS}s`;
      return `aborted after ${elapsedS}s`;
    default:
      return `failed after ${elapsedS}s: ${outcome.error?.message ?? outcome.status}`;
  }
}

function expertName(ref: ConsultExpertRef): string {
  return ref.label !== undefined && ref.label !== "" ? ref.label : ref.runId;
}

function preserveFailure(message: string | undefined): { outcome: ConsultOutcome; code: string } | undefined {
  if (message === undefined || !message.startsWith("[consult-preserve:")) return undefined;
  const end = message.indexOf("]");
  if (end < 0) return undefined;
  const code = message.slice("[consult-preserve:".length, end);
  const category = code.split(":", 1)[0];
  if (category === "identity_mismatch" || category === "guard_unavailable" || category === "blocked_cap")
    return { outcome: category, code };
  return undefined;
}

function preserveRefusal(name: string, code: string): string {
  return `Expert "${name}" could not be consulted without changing its tool definitions (${code}); the consult was refused to keep its read-only guarantee and prompt cache. Fall back to your own investigation.`;
}

function earlyCacheProbe(
  ref: ConsultExpertRef,
  outcome: ConsultOutcome,
  code?: string,
  snapshot?: ExpertRequestSnapshot,
) {
  return buildCacheProbe({
    ref,
    ...(snapshot === undefined ? {} : { snapshot }),
    outcome,
    ...(code === undefined ? {} : { outcomeError: `[consult-preserve:${code}]` }),
  });
}

/** Inputs needed to build one bounded C2 probe after a consult settles. */
export interface ConsultCacheProbeContext {
  ref: ConsultExpertRef;
  snapshot?: ExpertRequestSnapshot;
  outcome: ConsultOutcome;
  outcomeError?: string;
  consultRunId?: RunId;
  consultDiagnostics?: RunDiagnostics;
  expertLive?: RunSnapshot;
  expertSettledAt?: number;
  guardCounters?: ConsultGuardCounters;
  registry?: PrefixProbeRegistry;
  /** The consult's thread lease and the dispatch-time prediction — ONE fact projected onto the probe. */
  thread?: ThreadLease;
  predicted?: ConsultWarmPrediction;
}

/** Projection of a lease onto the asker-side probe's `thread` slot (same fact as the consult run's own diag.consultThread). */
export function threadProbeOf(lease: ThreadLease): NonNullable<ConsultCacheProbe["thread"]> {
  return {
    id: lease.threadId,
    seq: lease.seq,
    mode: lease.mode,
    ...(lease.reason === undefined ? {} : { reason: lease.reason }),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function prefixFailureCode(message: string | undefined): string | undefined {
  const failure = preserveFailure(message);
  return failure === undefined ? undefined : failure.code;
}

/**
 * Build the §4.1/§4.2 probe from process-local records. This is diagnostic
 * only: all reads are bounded, and a malformed/missing record degrades to an
 * omitted field rather than changing the consult result.
 */
export function buildCacheProbe(ctx: ConsultCacheProbeContext): ConsultCacheProbe | undefined {
  const registry = ctx.registry ?? getPrefixProbeRegistry();
  let consultRecord: RunPrefixRecord | undefined;
  let expertRecord: RunPrefixRecord | undefined;
  try {
    consultRecord = ctx.consultRunId === undefined ? undefined : registry.get(ctx.consultRunId);
    expertRecord = registry.get(ctx.ref.runId);
    const first = consultRecord?.first;
    const requests = consultRecord?.requests
      ?.filter((request) => request.usage !== undefined)
      .map((request) => ({ ...request.usage!, ...(request.toolsDrift === true ? { toolsDrift: true as const } : {}) }));
    const expertTools = ctx.snapshot?.tools.length ?? 0;
    const failureCode = prefixFailureCode(ctx.outcomeError);
    const identity: ConsultCacheProbe["identity"] = {
      preflight: failureCode === undefined ? "pass" : `fail:${failureCode}`,
      ...(ctx.snapshot === undefined ? {} : { expertTools }),
    };
    const predicted = ctx.consultDiagnostics?.consultIdentityPrediction;
    if (predicted !== undefined) identity.predicted = predicted;
    if (expertRecord?.latest !== undefined && first !== undefined) {
      const wire = compareRecordedPrefix(expertRecord.latest, first);
      identity.wire = {
        system: wire.system,
        tools: wire.tools,
        model: wire.model,
        thinking: wire.thinking,
      };
    }

    const expertSettledAt = ctx.expertLive?.diag.settledAt ?? ctx.expertSettledAt;
    const firstStartedAt = first?.startedAt;
    const gapSettleMs =
      firstStartedAt !== undefined && expertSettledAt !== undefined
        ? Math.max(0, firstStartedAt - expertSettledAt)
        : undefined;
    const gapLastRequestMs =
      firstStartedAt !== undefined && expertRecord?.latest?.endedAt !== undefined
        ? Math.max(0, firstStartedAt - expertRecord.latest.endedAt)
        : undefined;

    let expertPrefixTokens: number | undefined;
    let prefixSource: ConsultCacheProbe["prefixSource"];
    const usage = ctx.snapshot?.lastRequestUsage;
    if (usage !== undefined) {
      const input = finiteNonNegative(usage.input);
      const cacheRead = finiteNonNegative(usage.cacheRead);
      const cacheWrite = finiteNonNegative(usage.cacheWrite);
      if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
        expertPrefixTokens = input + cacheRead + cacheWrite;
        prefixSource = "snapshot-usage";
      }
    }
    if (expertPrefixTokens === undefined && ctx.ref.contextTokens !== undefined) {
      expertPrefixTokens = ctx.ref.contextTokens;
      prefixSource = "context-tokens";
    }

    const requestCost = (requests ?? []).reduce((sum, request) => sum + request.costUsd, 0);
    const totalCost = finiteNonNegative(ctx.consultDiagnostics?.usage?.costUsd);
    const keepalivePingUsd = totalCost === undefined ? undefined : Math.max(0, totalCost - requestCost);
    const hitRatio =
      expertPrefixTokens === undefined || expertPrefixTokens <= 0
        ? null
        : requests === undefined
          ? null
          : Math.max(
              0,
              Math.min(1, requests[0]?.cacheRead !== undefined ? requests[0].cacheRead / expertPrefixTokens : 0),
            );
    const guard =
      ctx.guardCounters === undefined && ctx.consultRunId !== undefined ? getConsultGuard(ctx.consultRunId) : undefined;
    const counters = ctx.guardCounters ?? guard?.counters();
    const blocked =
      counters === undefined
        ? undefined
        : {
            ...counters,
            costAfterUsd:
              counters.costAfterUsd > 0
                ? counters.costAfterUsd
                : counters.batches > 0 && requests !== undefined
                  ? requests
                      .slice(Math.min(counters.batches - 1, requests.length))
                      .reduce((sum, request) => sum + request.costUsd, 0)
                  : counters.costAfterUsd,
          };
    const probe: ConsultCacheProbe = {
      expertRunId: ctx.ref.runId,
      outcome: ctx.outcome,
      identity,
      ...(consultRecord?.api === undefined ? {} : { api: consultRecord.api }),
      ...(consultRecord?.provider === undefined ? {} : { provider: consultRecord.provider }),
      ...(consultRecord?.model === undefined ? {} : { model: consultRecord.model }),
      ...(gapSettleMs === undefined ? {} : { gapSettleMs }),
      ...(gapLastRequestMs === undefined ? {} : { gapLastRequestMs }),
      ...(expertPrefixTokens === undefined ? {} : { expertPrefixTokens }),
      ...(prefixSource === undefined ? {} : { prefixSource }),
      ...(requests === undefined ? {} : { requests }),
      ...(keepalivePingUsd === undefined ? {} : { keepalivePingUsd }),
      ...(hitRatio === undefined ? {} : { hitRatio }),
      ...(blocked === undefined ? {} : { blocked }),
      ...(ctx.thread === undefined ? {} : { thread: threadProbeOf(ctx.thread) }),
      ...(ctx.predicted === undefined ? {} : { warm: ctx.predicted }),
    };
    const anchorObs = consultRecord?.first?.anchor ?? consultRecord?.anchor;
    if (consultRecord !== undefined) {
      probe.anchor =
        anchorObs === undefined
          ? { state: "n/a" }
          : {
              state: anchorObs.state,
              ...(anchorObs.identity?.ttl ? { ttl: anchorObs.identity.ttl } : {}),
              ...(anchorObs.degraded ? { degraded: true as const } : {}),
            };
      probe.cacheResult = classifyConsultCacheResult(
        provenRequest(consultRecord)?.usage,
        anchorObs?.state ?? "n/a",
        anchorObs?.degraded ? true : undefined,
      );
    }
    return probe;
  } catch {
    if (consultRecord !== undefined) consultRecord.probeErrors = (consultRecord.probeErrors ?? 0) + 1;
    return {
      expertRunId: ctx.ref.runId,
      outcome: ctx.outcome,
      identity: {
        preflight:
          prefixFailureCode(ctx.outcomeError) === undefined ? "pass" : `fail:${prefixFailureCode(ctx.outcomeError)}`,
        ...(ctx.snapshot === undefined ? {} : { expertTools: ctx.snapshot.tools.length }),
        ...(ctx.consultDiagnostics?.consultIdentityPrediction === undefined
          ? {}
          : {
              predicted: ctx.consultDiagnostics.consultIdentityPrediction,
            }),
      },
      ...(ctx.thread === undefined ? {} : { thread: threadProbeOf(ctx.thread) }),
      ...(ctx.predicted === undefined ? {} : { warm: ctx.predicted }),
    };
  }
}

/**
 * The asker's roster: who it may consult and what each expert covered (its original task,
 * summarized at dispatch). Rendered into this run's own consult tool description, so the
 * dispatcher does not have to restate expert names in the task prompt.
 */
export function renderExpertRoster(whitelist: readonly ConsultExpertRef[], maxConcurrent: number): string {
  const rows = whitelist.map((ref) => {
    const who =
      ref.label !== undefined && ref.label !== "" && ref.label !== ref.runId
        ? `${ref.label} (${ref.runId})`
        : ref.runId;
    const model = ref.model !== undefined ? ` · ${ref.model.provider}/${ref.model.id}` : "";
    const isMain = ref.kind === "main";
    const kind = isMain ? "the host main session" : ref.agentType || "agent";
    const state = isMain
      ? "live — the orchestrating session, not a finished run"
      : ref.pending
        ? "still running when you were dispatched; consult nacks until it finishes"
        : "finished";
    const task = ref.task !== undefined ? ` — task: ${JSON.stringify(ref.task)}` : "";
    return `- ${who} — ${kind}${model} · ${state}${task}`;
  });
  const limit = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? ` (up to ${maxConcurrent} at once)` : "";
  return `Experts you can consult${limit}:\n${rows.join("\n")}`;
}

/** Estimate the first-request cost: full prefix rewrite at write price (§4.1, B-form always misses cache). */
export function estimateFirstRequestUsd(tokens: number, price: { input: number; cacheWrite: number }): number {
  return (tokens * Math.max(price.input, price.cacheWrite)) / 1e6;
}

/** Opaque identity of the expert's original session file (size + mtime); a change means it was resumed/rewritten. */
function sourceKeyOf(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/**
 * First line of a thread-aware result (plan §4.5): says truthfully what the
 * expert saw and whether this answer is retained. Six forms; the `m = 0`
 * variant of the branch form avoids the nonsensical "thread #0".
 */
export function threadFirstLine(lease: ThreadLease): string {
  const m = lease.retained;
  switch (lease.mode) {
    case "continued":
      return `[consult thread ${lease.threadId} #${lease.seq} — the expert sees your previous ${m} question(s) and its full answers]`;
    case "new":
      return "[new consult thread — no earlier Q/A with this expert]";
    case "fresh":
      return "[fresh consult (fresh:true) — earlier Q/A in this thread were dropped and will not be retained]";
    case "reset":
      return `[thread reset (${lease.reason ?? "identity"}) — the expert does NOT see your earlier questions]`;
    case "pending":
      return `[previous answer not yet retained — the expert sees up to #${m} only]`;
    case "branch":
      return m > 0
        ? `[parallel branch — the expert sees thread #${m}; this answer will NOT be kept for follow-ups]`
        : "[parallel branch — the expert sees no earlier Q/A in this thread; this answer will NOT be kept for follow-ups]";
  }
}

/** Truncation hint that depends on whether the answer will be retained in the thread (plan §4.5). */
export function threadTruncationNote(maxAnswerChars: number, retained: boolean): string {
  return retained
    ? `⚠ answer truncated at ${maxAnswerChars} chars; it will be kept in this consult thread once this consult closes — consult again (e.g. "continue from where you were cut off") to get the rest.`
    : `⚠ answer truncated at ${maxAnswerChars} chars; this answer is not retained — ask a narrower follow-up.`;
}

/** The request that may serve as evidence: `firstSuccessful`, else `first` unless it is known to have failed. */
export function provenRequest(record: RunPrefixRecord | undefined): RunPrefixRecord["first"] {
  if (record === undefined) return undefined;
  if (record.firstSuccessful !== undefined) return record.firstSuccessful;
  return record.first?.responseOk === false ? undefined : record.first;
}

export function createConsultTool(deps: ConsultDeps): ToolDefinition<typeof ConsultToolParams> {
  const probeRegistry = (): PrefixProbeRegistry => deps.prefixProbeRegistry ?? getPrefixProbeRegistry();
  /** Trusted anchor fact of a consult run: injected seam first, else the process prefix-probe record (package B). */
  const readAnchor = (consultRunId: RunId): AnchorObservation | undefined => {
    try {
      if (deps.anchorOf !== undefined) return deps.anchorOf(consultRunId);
      const record = probeRegistry().get(consultRunId);
      // B: `anchorIdentityValid === false` ⇒ the final body drifted from the verified baseline after hooks —
      // treat the anchor as absent (never a thread base, never warm-proof evidence).
      if (record?.first?.anchorIdentityValid === false) return undefined;
      // A failed/superseded first attempt with no successful one never proves the placement landed.
      if (record?.first !== undefined && provenRequest(record) === undefined) return undefined;
      return record?.first?.anchor ?? record?.anchor;
    } catch {
      return undefined;
    }
  };
  /**
   * §5.1: record a PROVEN touch — a real request that carried a verified anchor and whose first
   * response covered ≥90 % of the expert's measured request size. Time = request START.
   */
  const noteLedgerTouch = (p: {
    isMain: boolean;
    ref: ConsultExpertRef;
    snapshot?: ExpertRequestSnapshot;
    snapDigest?: string;
    model?: { provider: string; id: string };
    consultRunId: RunId;
    anchorObs: AnchorObservation | undefined;
  }): void => {
    try {
      const ledger = deps.anchorLedger;
      const obs = p.anchorObs;
      if (ledger === undefined || p.isMain || p.snapshot === undefined || p.snapDigest === undefined) return;
      if (p.model === undefined || obs === undefined || obs.identity === undefined) return;
      if (obs.state !== "added" && obs.state !== "relocated") return;
      // B: prefer the first SUCCESSFUL request; a failed/superseded first attempt (responseOk === false) with
      // no successful one is no evidence at all (strict-tool fallback may fire onPayload twice).
      const first = provenRequest(probeRegistry().get(p.consultRunId));
      const usage = first?.usage;
      const last = p.snapshot.lastRequestUsage;
      if (first === undefined || usage === undefined || last === undefined) return;
      if (first.anchorIdentityValid === false) return; // identity drift ⇒ same as an absent anchor
      const baseLB = last.input + last.cacheRead + last.cacheWrite;
      if (!(baseLB > 0) || usage.cacheRead + usage.cacheWrite < 0.9 * baseLB) return;
      ledger.noteTouch({
        expertRunId: p.ref.runId,
        route: { provider: p.model.provider, model: p.model.id },
        snapDigest: p.snapDigest,
        anchor: obs.state,
        ...(obs.degraded === true ? { degraded: true } : {}),
        touchedAt: first.startedAt,
        ...(obs.identity.ttl === "1h" ? { ttl1h: true } : {}),
      });
    } catch {
      /* diagnostics only — never affects the consult result */
    }
  };
  return {
    name: "consult",
    label: "Consult",
    description:
      "Ask a finished expert subagent run a question and get the answer inside this tool call. `expert` must be " +
      "an entry of this run's expert whitelist (its dispatching agent attached and validated the list at dispatch " +
      "time). The expert's persisted session is forked read-only for the question: it sees its own full history " +
      "plus your question, runs in the asking agent's own worktree when the asker is worktree-isolated; " +
      "otherwise in the expert's original checkout if it still exists, else the asker's checkout — with only " +
      "read/grep/find/ls, and is bounded to a few turns and a short wall-clock budget. There is no fallback to a " +
      "fresh agent — if the expert is unavailable (still running, session gone, context too full, cost too high) " +
      "you get a clear negative answer; investigate yourself instead of retrying." +
      `\n\n${renderExpertRoster(deps.whitelist, deps.settings().maxConcurrent)}`,
    promptSnippet: "consult(expert, question) - ask a whitelisted finished expert run and get its answer in-turn",
    parameters: ConsultToolParams,
    async execute(_toolCallId, params, signal) {
      const s = deps.settings();
      // D10 (workflow-worktree plan §2): read the asker's cwd cell EXACTLY
      // ONCE per call — the getter contract requires this (the cell can be
      // mutated by late H2 activity in theory, but every call must see one
      // consistent snapshot for its whole duration).
      const asker = deps.selfCwd();
      // ① Caller-mistake validation FIRST (throw, never nack — §4.1 error table row 1).
      const question = params.question.trim();
      if (question.length === 0) throw new Error("consult: question must not be empty.");
      const ref = matchExpertRef(params.expert, deps.whitelist);
      const isMain = ref.kind === "main";
      if (!s.enabled) {
        return {
          content: [{ type: "text" as const, text: `consult is disabled (consult.enabled=false).` }],
          details: {
            expertRunId: ref.runId,
            ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
            outcome: "unavailable",
          } satisfies ConsultToolDetails,
        };
      }
      // ② Concurrency gate (per-asker maxConcurrent + global cap; wireConsult closure).
      if (!deps.inflight.tryAcquire(deps.selfRunId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Too many concurrent consults (max ${s.maxConcurrent}). Wait for one to finish or ask sequentially.`,
            },
          ],
          details: {
            expertRunId: ref.runId,
            ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
            outcome: "busy",
          } satisfies ConsultToolDetails,
        };
      }
      // cache-thread plan: per-call thread state, released in the single `finally` below.
      let lease: ThreadLease | undefined;
      let forkPath: string | undefined;
      let forkSettled = false;
      try {
        // ③ Liveness re-check (§4.5): runId live non-terminal, OR any running
        // run holding the same sessionFile (covers `Agent({resume})`
        // continuing the expert under a new runId — resumeLocks is
        // spawn-service-private, the sessionFile scan is the observable half).
        // §16 rule 1: the host main session is never tracked as a "run" — it
        // is live by construction, so this whole re-check is skipped for it
        // (there is nothing to nack as still_running).
        let live: RunSnapshot | undefined;
        if (!isMain) {
          live = deps.query.get(ref.runId);
          if (live !== undefined && !isTerminal(live.status)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Expert "${expertName(ref)}" is still running; use steer_subagent-style follow-up via your dispatcher instead.`,
                },
              ],
              details: {
                expertRunId: ref.runId,
                ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
                outcome: "still_running",
              } satisfies ConsultToolDetails,
            };
          }
          for (const snap of deps.query.list()) {
            if (isTerminal(snap.status)) continue;
            if (snap.diag.sessionFile !== undefined && snap.diag.sessionFile === ref.sessionFile) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Expert "${expertName(ref)}" is still running; use steer_subagent-style follow-up via your dispatcher instead.`,
                  },
                ],
                details: {
                  expertRunId: ref.runId,
                  ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
                  outcome: "still_running",
                } satisfies ConsultToolDetails,
              };
            }
          }
        }
        // §16 rule 3: fork the CURRENT persisted file, not a dispatch-time
        // snapshot. For a real expert `ref.sessionFile` already IS the
        // (static, terminal) file; for main it is read fresh right here, so a
        // subagent calling consult("main", …) long after dispatch still gets
        // the host's live file/model/context, never a stale one.
        const mainFacts: MainSessionFacts | undefined = isMain ? (deps.mainSessionFacts?.() ?? {}) : undefined;
        const sessionFile = isMain ? mainFacts!.sessionFile : ref.sessionFile;
        if (sessionFile === undefined || sessionFile.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  'Expert "main" could not be consulted: the host main session has no persisted session ' +
                  "(it was started with --no-session). Fall back to your own investigation.",
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "unavailable",
            } satisfies ConsultToolDetails,
          };
        }
        if (!fileExists(sessionFile)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Expert "${expertName(ref)}" could not be consulted: its session file is missing (${sessionFile}). Fall back to your own investigation.`,
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "unavailable",
            } satisfies ConsultToolDetails,
          };
        }
        // ④ Pre-checks, before the fork — a rejection here creates no file.
        //    Context: for a real expert, the freshest live value when it
        //    still has a record, else the dispatch-time snapshot (a live
        //    snapshot reporting percent = null means "unknown" → skip,
        //    review-2 #15③, rather than resurrecting a stale ref value). For
        //    main (§16 rule 4) it is whatever `mainSessionFacts()` just
        //    reported — there is no dispatch-time fallback to resurrect.
        const liveContext = isMain ? undefined : live?.diag.contextUsage;
        const effectivePercent = isMain
          ? mainFacts!.contextPercent
          : liveContext !== undefined
            ? liveContext.percent
            : ref.contextPercent;
        if (effectivePercent != null && effectivePercent >= CONSULT_MAX_CONTEXT_PERCENT) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Expert "${expertName(ref)}" session is ~${Math.round(effectivePercent)}% of its context window; ` +
                  `a consult would likely force compaction and blow the ${Math.round(s.timeoutMs / 1000)}s budget. ` +
                  "Ask your dispatcher for a targeted resume instead.",
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "context_too_large",
            } satisfies ConsultToolDetails,
          };
        }
        //    First-request cost (§4.1, review-3 #4/#7): the fork path rewrites
        //    the whole prefix at write price, so estimate
        //    tokens × max(input, cacheWrite) and gate on maxFirstRequestUsd.
        //    Missing tokens or unknown price → skip for a real expert (the
        //    turn-boundary cap still guards); for main (§16 rule 4) missing
        //    data is instead a hard nack — the host session is always live,
        //    so a missing model/token reading means the estimate cannot be
        //    trusted at all, not merely "unavailable this time".
        const tokens = isMain
          ? mainFacts!.contextTokens
          : liveContext === undefined
            ? ref.contextTokens
            : liveContext.tokens === null
              ? ref.contextTokens
              : liveContext.tokens;
        const model = isMain ? mainFacts!.model : ref.model;
        if (isMain && (tokens === undefined || tokens === null || model === undefined)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  'Expert "main" could not be consulted: cannot estimate the first-request cost right now ' +
                  "(the host session's current model or context size is unavailable). Fall back to your own investigation.",
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "unavailable",
            } satisfies ConsultToolDetails,
          };
        }
        let costEstimateUsd: number | undefined;
        let turnBudgetHint: number | undefined;
        let budgetNote = false;
        if (tokens !== undefined && tokens !== null && model !== undefined) {
          const price = deps.priceOf(model, tokens);
          if (price !== undefined) {
            const est = estimateFirstRequestUsd(tokens, price);
            costEstimateUsd = est;
            if (s.maxFirstRequestUsd > 0 && est > s.maxFirstRequestUsd) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Consulting "${expertName(ref)}" would cost ~$${est.toFixed(2)} for the first request alone ` +
                      `(first-request cap $${s.maxFirstRequestUsd}; the expert's ~${tokens} tokens are re-sent uncached). ` +
                      "Ask your dispatcher, or raise consult.maxFirstRequestUsd.",
                  },
                ],
                details: {
                  expertRunId: ref.runId,
                  ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
                  costEstimateUsd: est,
                  outcome: "cost_too_high",
                } satisfies ConsultToolDetails,
              };
            }
            if (s.maxCostUsd > 0 && est > 0) {
              const remaining = s.maxCostUsd - est;
              budgetNote = remaining < est;
              turnBudgetHint = Math.max(1, Math.floor(remaining / est) + 1);
            }
          }
        }
        // ⑤ Fork (never throws — §15 #2). Rejection here still spawned
        // nothing. Main gets the consistency-checked variant when the store
        // provides one (§16 rule 5 — the host file can be concurrently
        // appended to/rewritten, unlike a terminal expert's). D10
        // (workflow-worktree plan §2): an isolated asker forces the fork's
        // header cwd to its own worktree (`forceCwd:true`) instead of the
        // usual two-level resolution against the expert's original cwd.
        const forkOpts = asker.isolated ? { forceCwd: true as const } : undefined;
        // cache-thread plan §4: the cwd is resolved once, from the expert's ORIGINAL session
        // (a head fork's header already carries the same resolution).
        const cwd = asker.isolated ? asker.cwd : (deps.forkStore.resolveForkCwd?.(sessionFile, asker.cwd) ?? asker.cwd);
        const threads = isMain ? undefined : deps.threads;
        const sourceKey = isMain ? undefined : sourceKeyOf(sessionFile);
        // §4.6: head-based admission. Context at 75 %, first request estimated as a conservative
        // COLD write (head.tokens × max(input, write)) per the user ruling; the original session
        // already passed both gates above, so a failure here resets the thread, never nacks.
        const headGuard = (head: Readonly<ThreadHead>): ThreadReason | undefined => {
          const window =
            liveContext?.contextWindow ??
            (ref.contextTokens !== undefined && ref.contextPercent != null && ref.contextPercent > 0
              ? (ref.contextTokens / ref.contextPercent) * 100
              : undefined);
          const percent =
            head.percent ?? (window !== undefined && head.tokens > 0 ? (head.tokens / window) * 100 : undefined);
          if (percent != null && percent >= CONSULT_MAX_CONTEXT_PERCENT) return "context";
          if (head.tokens > 0 && model !== undefined && s.maxFirstRequestUsd > 0) {
            const price = deps.priceOf(model, head.tokens);
            if (price !== undefined && estimateFirstRequestUsd(head.tokens, price) > s.maxFirstRequestUsd)
              return "cost";
          }
          return undefined;
        };
        let fork: ForkExpertSessionResult = { ok: false, reason: "not forked" };
        let consultSnapshot: ExpertRequestSnapshot | undefined;
        let snapDigest: string | undefined;
        // At most two rounds: round 2 only happens after a loadout-identity mismatch on a thread
        // head (plan §4.1 reason `identity`), forcing a reset from the original session.
        for (let round = 0; round < 2; round++) {
          if (lease !== undefined) {
            threads?.finish(lease);
            lease = undefined;
          }
          lease = threads?.begin({
            askerRunId: deps.selfRunId,
            expertRunId: ref.runId,
            originalFile: sessionFile,
            ...(sourceKey === undefined ? {} : { sourceKey }),
            ...(params.fresh === true ? { fresh: true } : {}),
            ...(round === 1 ? { forceReset: "identity" as const } : {}),
            headGuard,
          });
          const forkSource = lease?.sourceFile ?? sessionFile;
          fork =
            isMain && deps.forkStore.forkMainSession
              ? deps.forkStore.forkMainSession(sessionFile, asker.cwd, forkOpts)
              : deps.forkStore.forkExpertSession(forkSource, asker.cwd, forkOpts);
          if (!fork.ok) break;
          // C2 snapshot reconstruction happens after the fork and before spawn.
          // Main intentionally remains the documented Q1 read-only exception.
          if (isMain) break;
          const scanned = deps.forkStore.scanExpertSnapshot(fork.path);
          if (!scanned.ok) {
            deps.forkStore.removeForkFile(fork.path);
            const probe = earlyCacheProbe(ref, "identity_mismatch", scanned.code);
            return {
              content: [{ type: "text" as const, text: preserveRefusal(expertName(ref), scanned.code) }],
              details: {
                expertRunId: ref.runId,
                ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
                outcome: "identity_mismatch",
                configError: scanned.code,
                ...(probe === undefined ? {} : { cacheProbe: probe }),
              } satisfies ConsultToolDetails,
            };
          }
          consultSnapshot = scanned.snapshot;
          snapDigest = snapDigestOf({
            tools: consultSnapshot.tools,
            systemSections: consultSnapshot.systemSections,
            cwd,
            ...(sourceKey === undefined ? {} : { sourceKey }),
          });
          if (lease === undefined || threads === undefined || threads.noteDigest(lease, snapDigest)) break;
          // The loadout drifted from this thread's first request: never continue on a different prefix.
          deps.forkStore.removeForkFile(fork.path);
          consultSnapshot = undefined;
          fork = { ok: false, reason: "thread identity mismatch" };
        }
        if (!fork.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Expert "${expertName(ref)}" could not be consulted: could not fork the expert's session: ${fork.reason}. Fall back to your own investigation.`,
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "unavailable",
            } satisfies ConsultToolDetails,
          };
        }
        forkPath = fork.path;
        // Continued/pending/branch consults start from a head, whose tokens drive the estimate.
        if (lease?.head !== undefined && lease.head.tokens > 0 && model !== undefined) {
          const price = deps.priceOf(model, lease.head.tokens);
          if (price !== undefined) {
            const est = estimateFirstRequestUsd(lease.head.tokens, price);
            costEstimateUsd = est;
            if (s.maxCostUsd > 0 && est > 0) {
              const remaining = s.maxCostUsd - est;
              budgetNote = remaining < est;
              turnBudgetHint = Math.max(1, Math.floor(remaining / est) + 1);
            }
          }
        }
        const promptLists = consultSnapshot === undefined ? undefined : consultPromptLists(consultSnapshot);
        const spawnModel = consultSnapshot?.model ?? model;
        // ⑥ Spawn the consult run through the narrow port. D10: an isolated
        // asker's consult always runs in the asker's own worktree — no call
        // to `resolveForkCwd` at all. An unisolated asker keeps the §5.1
        // two-level rule unchanged: the expert's header cwd when it still
        // exists (preserved worktrees), else the asker's cwd.
        const consultPrompt = buildConsultPrompt({
          question,
          maxAnswerChars: s.maxAnswerChars,
          budgetNote,
          isMain,
          // A head-sourced consult (continued / pending / branch) is follow-up #(retained+1).
          ...(lease?.head === undefined ? {} : { followUp: lease.retained + 1 }),
          ...(promptLists === undefined ? {} : promptLists),
        });
        // §5.1 + R2-4: ONE dispatch-time fact — the prediction and the thread position — is both
        // written to the consult run's own diag (take-once, keyed by the fork path, folded by the
        // adapter at enqueue) and projected onto the asker-side probe below. EVERY consult run
        // gets `predicted` (main / no evidence / OAuth ⇒ `{state:"unknown"}`), never absent.
        const settledForPredict = live?.diag.settledAt ?? deps.expertSettledAt?.(ref.runId);
        const routeApi = spawnModel === undefined || isMain ? undefined : deps.routeApi?.(spawnModel);
        const predicted: ConsultWarmPrediction = deps.anchorLedger?.predict({
          isMain,
          expertRunId: ref.runId,
          ...(spawnModel === undefined || isMain
            ? {}
            : { route: { provider: spawnModel.provider, model: spawnModel.id } }),
          ...(routeApi === undefined ? {} : { api: routeApi }),
          ...(snapDigest === undefined ? {} : { snapDigest }),
          ...(lease?.head !== undefined && lease.base === undefined ? { followUpWithoutBase: true } : {}),
          ...(typeof settledForPredict === "number" ? { settledAt: settledForPredict } : {}),
        }) ?? { state: "unknown", reason: isMain ? "main" : "no-evidence" };
        deps.displayMeta?.put(fork.path, {
          consultCache: { v: 1, predicted },
          ...(lease === undefined ? {} : { consultThread: { threadId: lease.threadId, seq: lease.seq } }),
        });
        if (lease !== undefined) threads?.openFork(lease, fork.path);
        let started: { runId: RunId; label?: string } | { error: ErrorInfo };
        try {
          started = await deps.port.spawn({
            type: ref.agentType,
            prompt: consultPrompt,
            // Host-side anchor placement handoff (NOT_THREADED A type; consumed by package B).
            consultAnchor: { prompt: consultPrompt, ...(lease?.base === undefined ? {} : { base: lease.base }) },
            label: consultRunLabel(expertName(ref)),
            ...(spawnModel !== undefined ? { modelOverride: spawnModel } : {}),
            ...(consultSnapshot === undefined ? {} : { consultSnapshot }),
            cwd,
            forkSessionFrom: fork.path,
            parentRunId: deps.selfRunId,
            slotless: true,
            expectAck: true,
            budgetOverride: { totalMs: s.timeoutMs },
            ...(signal !== undefined ? { signal } : {}),
          });
        } catch (e) {
          // Admission threw: nothing has touched the fork file yet — delete
          // it here and now (no race possible, §4.1 error table last row).
          const message = e instanceof Error ? e.message : String(e);
          deps.forkStore.removeForkFile(fork.path);
          if (lease !== undefined) threads?.abandonFork(lease, fork.path);
          deps.displayMeta?.drop(fork.path);
          const preserve = preserveFailure(message);
          const probe = earlyCacheProbe(ref, preserve?.outcome ?? "unavailable", preserve?.code, consultSnapshot);
          return {
            content: [
              {
                type: "text" as const,
                text: preserve
                  ? preserveRefusal(expertName(ref), preserve.code)
                  : `Expert "${expertName(ref)}" could not be launched: ${message}`,
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: preserve?.outcome ?? "unavailable",
              configError: message,
              ...(probe === undefined ? {} : { cacheProbe: probe }),
            } satisfies ConsultToolDetails,
          };
        }
        if ("error" in started) {
          deps.forkStore.removeForkFile(fork.path);
          if (lease !== undefined) threads?.abandonFork(lease, fork.path);
          deps.displayMeta?.drop(fork.path);
          const preserve = preserveFailure(started.error.message);
          const probe = earlyCacheProbe(ref, preserve?.outcome ?? "unavailable", preserve?.code, consultSnapshot);
          return {
            content: [
              {
                type: "text" as const,
                text: preserve
                  ? preserveRefusal(expertName(ref), preserve.code)
                  : `Expert "${expertName(ref)}" could not be launched: ${started.error.message}`,
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: preserve?.outcome ?? "unavailable",
              configError: started.error.message,
              ...(probe === undefined ? {} : { cacheProbe: probe }),
            } satisfies ConsultToolDetails,
          };
        }
        // From here on the fork file belongs to the runner: onReaped (normal
        // /late/early-exit paths) and the sweep own its deletion — this tool
        // must never removeForkFile a started run (T-4).
        const consultRunId = started.runId;
        // ⑦/⑧ Watch (turn-boundary caps) + wait for the outcome. The
        // registration happens on the same continuation that received the
        // runId, and the first turn_start only fires after session_create's
        // I/O awaits, so no cap-worthy snapshot can be missed (§4.1).
        const watcher = createCapWatcher({
          maxTurns: s.maxTurns,
          maxCostUsd: s.maxCostUsd,
          onCap: (reason) => queueMicrotask(() => deps.port.abortRun(consultRunId, reason)),
        });
        let settledGuardCounters: ConsultGuardCounters | undefined;
        const onSnapshot = (snapshot: RunSnapshot): void => {
          watcher.onSnapshot(snapshot);
          if (isTerminal(snapshot.status) && settledGuardCounters === undefined)
            settledGuardCounters = getConsultGuard(consultRunId)?.counters();
        };
        const unwatch = deps.port.watchRun(consultRunId, onSnapshot);
        let outcome: RunOutcome;
        try {
          outcome = await deps.port.waitOutcome(consultRunId);
        } finally {
          unwatch();
        }
        // ⑨ Result assembly (§4.1): truncate WITHOUT sessionFile (the fork
        // file is about to be deleted — never point the asker at it, §5.5).
        const capReason = watcher.capReason;
        const preserve = preserveFailure(outcome.error?.message);
        const outcomeTag = preserve?.outcome ?? outcomeLabel(outcome, capReason);
        const guardCounters = settledGuardCounters ?? getConsultGuard(outcome.runId)?.counters();
        const effectiveOutcome: ConsultOutcome = guardCounters?.terminated ? "blocked_cap" : outcomeTag;
        const settledAt = deps.expertSettledAt?.(ref.runId);
        const hasAnswerText = outcome.text !== undefined && outcome.text.trim().length > 0;
        // §4.2 ②: eligible to become the thread head only for a clean, completed, non-empty answer.
        const eligible =
          lease?.keep === true &&
          outcome.status === "completed" &&
          effectiveOutcome === "completed" &&
          preserve === undefined &&
          hasAnswerText;
        const anchorObs = readAnchor(outcome.runId);
        if (lease !== undefined && threads !== undefined) {
          const record = probeRegistry().get(outcome.runId);
          const lastReq = record?.requests?.filter((r) => r.usage !== undefined).at(-1)?.usage;
          const ctxUsage = outcome.diag.contextUsage;
          const tokens =
            ctxUsage?.tokens ??
            (lastReq === undefined
              ? undefined
              : lastReq.input + lastReq.cacheRead + lastReq.cacheWrite + lastReq.output);
          const base: AnchorIdentity | undefined =
            (anchorObs?.state === "added" || anchorObs?.state === "relocated") &&
            anchorObs.degraded !== true &&
            anchorObs.identity !== undefined
              ? anchorObs.identity
              : undefined;
          forkSettled = true;
          threads.settle(fork.path, {
            eligible,
            consultRunId: outcome.runId,
            ...(tokens === undefined ? {} : { tokens }),
            ...(ctxUsage === undefined ? {} : { percent: ctxUsage.percent }),
            ...(base === undefined ? {} : { base }),
          });
        }
        noteLedgerTouch({
          isMain,
          ref,
          ...(consultSnapshot === undefined ? {} : { snapshot: consultSnapshot }),
          ...(snapDigest === undefined ? {} : { snapDigest }),
          ...(spawnModel === undefined ? {} : { model: spawnModel }),
          consultRunId: outcome.runId,
          anchorObs,
        });
        const cacheProbe = buildCacheProbe({
          ...(lease === undefined ? {} : { thread: lease }),
          predicted,
          ref,
          ...(consultSnapshot === undefined ? {} : { snapshot: consultSnapshot }),
          outcome: effectiveOutcome,
          ...(outcome.error?.message === undefined ? {} : { outcomeError: outcome.error.message }),
          consultRunId: outcome.runId,
          consultDiagnostics: outcome.diag,
          ...(live === undefined || isMain ? {} : { expertLive: live }),
          ...(settledAt === undefined ? {} : { expertSettledAt: settledAt }),
          ...(guardCounters === undefined ? {} : { guardCounters }),
          ...(deps.prefixProbeRegistry === undefined ? {} : { registry: deps.prefixProbeRegistry }),
        });
        const baseDetails = {
          expertRunId: ref.runId,
          ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
          consultRunId: outcome.runId,
          ...(outcome.diag.model !== undefined
            ? { model: `${outcome.diag.model.provider}/${outcome.diag.model.id}` }
            : {}),
          ...(outcome.usage !== undefined ? { costUsd: outcome.usage.costUsd } : {}),
          ...(costEstimateUsd !== undefined ? { costEstimateUsd } : {}),
          ...(turnBudgetHint !== undefined ? { turnBudgetHint } : {}),
          durationMs: outcome.durationMs,
          turns: outcome.turns,
          ...(outcome.diag.toolCounts !== undefined ? { toolCounts: outcome.diag.toolCounts } : {}),
          ...(cacheProbe === undefined ? {} : { cacheProbe }),
        };
        const usage = outcome.usage !== undefined ? { usage: toPiToolUsage(outcome.usage) } : {};
        if (preserve !== undefined) {
          return {
            content: [{ type: "text" as const, text: preserveRefusal(expertName(ref), preserve.code) }],
            ...usage,
            details: {
              ...baseDetails,
              outcome: effectiveOutcome,
              ...(outcome.error?.message === undefined ? {} : { configError: outcome.error.message }),
            } satisfies ConsultToolDetails,
          };
        }
        if (outcome.status === "completed") {
          const raw =
            outcome.text !== undefined && outcome.text.trim().length > 0
              ? outcome.text
              : "(the expert completed without any text output)";
          const truncated = truncateResultText(raw, s.maxAnswerChars);
          // eval-2026-10.md §4: 20% of completed answers hit the cap, causing
          // 12 follow-up consults — the model was never told it got a partial
          // answer or how to get the rest. Keep the cap itself (plan §4.1);
          // just say so explicitly.
          const legacyText = truncated.truncated
            ? `${truncated.text}\n\n⚠ answer truncated at ${s.maxAnswerChars} chars; ask a narrower follow-up ` +
              `(reference a specific item or range) instead of re-asking the whole question.`
            : truncated.text;
          const text =
            lease === undefined
              ? legacyText
              : `${threadFirstLine(lease)}\n\n${
                  truncated.truncated
                    ? `${truncated.text}\n\n${threadTruncationNote(s.maxAnswerChars, eligible)}`
                    : truncated.text
                }`;
          return {
            content: [{ type: "text" as const, text }],
            ...usage,
            details: {
              ...baseDetails,
              truncated: truncated.truncated,
              outcome: effectiveOutcome,
            } satisfies ConsultToolDetails,
          };
        }
        const hasText = outcome.text !== undefined && outcome.text.trim().length > 0;
        if (!hasText) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Expert "${expertName(ref)}" did not answer (consult run ${outcome.runId}: ` +
                  `${humanReason(outcome, capReason, s)}). ` +
                  "Fall back to your own investigation.",
              },
            ],
            ...usage,
            details: { ...baseDetails, outcome: effectiveOutcome } satisfies ConsultToolDetails,
          };
        }
        const truncated = truncateResultText(outcome.text!, s.maxAnswerChars);
        const truncationNote = truncated.truncated
          ? ` answer truncated at ${s.maxAnswerChars} chars; ask a narrower follow-up.`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `${lease === undefined ? "" : `${threadFirstLine(lease)}\n\n`}${truncated.text}\n\n⚠ partial answer — consult ended early (${humanReason(outcome, capReason, s)}).${truncationNote}`,
            },
          ],
          ...usage,
          details: {
            ...baseDetails,
            truncated: truncated.truncated,
            partial: true,
            outcome: effectiveOutcome,
          } satisfies ConsultToolDetails,
        };
      } finally {
        // Rejection paths above return through here too — the gate is always
        // released (T-2: "nack 后并发计数已释放").
        deps.inflight.release(deps.selfRunId);
        if (lease !== undefined && deps.threads !== undefined) {
          // An aborted/throwing call never judged its answer: it must not stay a pending candidate.
          if (forkPath !== undefined && !forkSettled) deps.threads.settle(forkPath, { eligible: false });
          deps.threads.finish(lease);
        }
        if (forkPath !== undefined) deps.displayMeta?.drop(forkPath);
      }
    },
  };
}
