import { existsSync, statSync } from "node:fs";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ConsultExpertRef,
  ErrorInfo,
  ForkExpertSessionResult,
  RunId,
  RunOutcome,
  RunSnapshot,
  SpawnRequest,
} from "../core/types.js";
import type { ConsultSettings } from "../config/settings.js";
import type { QueryService } from "../service/query-service.js";
import type { SpawnService } from "../service/spawn-service.js";
import { toPiToolUsage } from "../tools/usage.js";
import { truncateResultText } from "../tools/result-text.js";
import { buildConsultPrompt } from "./prompt.js";
import { createCapWatcher, type ConsultCapReason } from "./watcher.js";
import type { MainSessionFacts, MainSessionFactsProvider } from "./main-facts.js";

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
      "The question, self-contained. The expert sees its own history plus this question (nothing from your session).",
  }),
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
  /** Synchronous expert-session fork; NEVER throws (§15 #2 — failures fold into `{ok:false,reason}`). */
  forkExpertSession(sourceFile: string, fallbackCwd: string): ForkExpertSessionResult;
  /**
   * consult (plan §16 rule 5): consistency-checked variant used ONLY for
   * the host main session — unlike a terminal expert's file, main's can be
   * concurrently appended to (or wholesale rewritten by pi's own
   * `_rewriteFile`) at the exact moment `consult("main", …)` runs.
   * Optional: falls back to `forkExpertSession` when a fork store does not
   * provide it (e.g. package C unit tests with a plain stub).
   */
  forkMainSession?(sourceFile: string, fallbackCwd: string): ForkExpertSessionResult;
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

export interface ConsultDeps {
  /** The asking run's id — parentRunId of the consult run and the concurrency key. */
  selfRunId: RunId;
  /** The asker's cwd (fork cwd fallback + the checkout the consult runs in). */
  selfCwd: string;
  /** Dispatch-time resolved expert whitelist (SpawnRequest.consultExperts — trusted). */
  whitelist: readonly ConsultExpertRef[];
  port: ConsultSpawnPort;
  /** Live state/terminal snapshots (liveness re-check + freshest contextUsage). */
  query: QueryService;
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
}

/** `details.outcome` vocabulary of the consult tool result (§4.1 error table). */
export type ConsultOutcome =
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
  | "aborted";

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

/** `consult-<rand4>` (review-1 #11): random base so high-frequency consults never exhaust the label suffix space. */
export function consultRunLabel(): string {
  return `consult-${randomBase36(4)}`;
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

/**
 * Match `expert` against the run's whitelist: exact runId → exact label →
 * unique runId prefix (§4.1 ①). Anything else is the asker's own mistake →
 * throw, same precedent as Agent's allowedTypes check.
 */
export function matchExpertRef(handle: string, whitelist: readonly ConsultExpertRef[]): ConsultExpertRef {
  const trimmed = handle.trim();
  const byExactId = whitelist.find((ref) => ref.runId === trimmed);
  if (byExactId) return byExactId;
  const byLabel = whitelist.filter((ref) => ref.label === trimmed);
  if (byLabel.length === 1 && byLabel[0]) return byLabel[0];
  const byPrefix = whitelist.filter((ref) => trimmed.length > 0 && ref.runId.startsWith(trimmed));
  if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0];
  throw new Error(
    `consult: expert "${handle}" is not in this run's expert whitelist (allowed: ${describeWhitelist(whitelist)}). ` +
      "Ask your dispatcher to add it, or answer from your own context.",
  );
}

function outcomeLabel(outcome: RunOutcome, capReason: ConsultCapReason | undefined): ConsultOutcome {
  if (outcome.status === "aborted" && capReason !== undefined) return capReason; // §15 #1: real reason over user_stop
  if (outcome.status === "timed_out") return "timeout";
  return outcome.status; // completed | failed | aborted
}

function humanReason(outcome: RunOutcome, capReason: ConsultCapReason | undefined, timeoutMs: number): string {
  switch (outcome.status) {
    case "timed_out":
      return `timed out after ${Math.round(timeoutMs / 1000)}s`;
    case "aborted":
      if (capReason === "turn_cap") return "cut off at the turn cap";
      if (capReason === "cost_cap") return "cut off at the cost cap";
      return "aborted";
    default:
      return `failed: ${outcome.error?.message ?? outcome.status}`;
  }
}

function expertName(ref: ConsultExpertRef): string {
  return ref.label !== undefined && ref.label !== "" ? ref.label : ref.runId;
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

export function createConsultTool(deps: ConsultDeps): ToolDefinition<typeof ConsultToolParams> {
  return {
    name: "consult",
    label: "Consult",
    description:
      "Ask a finished expert subagent run a question and get the answer inside this tool call. `expert` must be " +
      "an entry of this run's expert whitelist (its dispatching agent attached and validated the list at dispatch " +
      "time). The expert's persisted session is forked read-only for the question: it sees its own full history " +
      "plus your question, runs in the asking agent's checkout (not its original worktree) with only " +
      "read/grep/find/ls, and is bounded to a few turns and a short wall-clock budget. There is no fallback to a " +
      "fresh agent — if the expert is unavailable (still running, session gone, context too full, cost too high) " +
      "you get a clear negative answer; investigate yourself instead of retrying." +
      `\n\n${renderExpertRoster(deps.whitelist, deps.settings().maxConcurrent)}`,
    promptSnippet: "consult(expert, question) - ask a whitelisted finished expert run and get its answer in-turn",
    parameters: ConsultToolParams,
    async execute(_toolCallId, params, signal) {
      const s = deps.settings();
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
        // appended to/rewritten, unlike a terminal expert's).
        const fork =
          isMain && deps.forkStore.forkMainSession
            ? deps.forkStore.forkMainSession(sessionFile, deps.selfCwd)
            : deps.forkStore.forkExpertSession(sessionFile, deps.selfCwd);
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
        // ⑥ Spawn the consult run through the narrow port. Fork cwd: the
        // expert's header cwd when it still exists (preserved worktrees),
        // else the asker's cwd (§5.1 two-level; the consulted copy always
        // runs in a live checkout of the asking side).
        const cwd = deps.forkStore.resolveForkCwd?.(sessionFile, deps.selfCwd) ?? deps.selfCwd;
        let started: { runId: RunId; label?: string } | { error: ErrorInfo };
        try {
          started = await deps.port.spawn({
            type: ref.agentType,
            prompt: buildConsultPrompt({
              question,
              maxAnswerChars: s.maxAnswerChars,
              budgetNote,
              isMain,
            }),
            label: consultRunLabel(),
            ...(model !== undefined ? { modelOverride: model } : {}),
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
          return {
            content: [{ type: "text" as const, text: `Expert "${expertName(ref)}" could not be launched: ${message}` }],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "unavailable",
              configError: message,
            } satisfies ConsultToolDetails,
          };
        }
        if ("error" in started) {
          deps.forkStore.removeForkFile(fork.path);
          return {
            content: [
              {
                type: "text" as const,
                text: `Expert "${expertName(ref)}" could not be launched: ${started.error.message}`,
              },
            ],
            details: {
              expertRunId: ref.runId,
              ...(ref.label !== undefined ? { expertLabel: ref.label } : {}),
              outcome: "unavailable",
              configError: started.error.message,
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
        const unwatch = deps.port.watchRun(consultRunId, watcher.onSnapshot);
        let outcome: RunOutcome;
        try {
          outcome = await deps.port.waitOutcome(consultRunId);
        } finally {
          unwatch();
        }
        // ⑨ Result assembly (§4.1): truncate WITHOUT sessionFile (the fork
        // file is about to be deleted — never point the asker at it, §5.5).
        const capReason = watcher.capReason;
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
        };
        const usage = outcome.usage !== undefined ? { usage: toPiToolUsage(outcome.usage) } : {};
        if (outcome.status === "completed") {
          const raw =
            outcome.text !== undefined && outcome.text.trim().length > 0
              ? outcome.text
              : "(the expert completed without any text output)";
          const truncated = truncateResultText(raw, s.maxAnswerChars);
          return {
            content: [{ type: "text" as const, text: truncated.text }],
            ...usage,
            details: {
              ...baseDetails,
              truncated: truncated.truncated,
              outcome: "completed",
            } satisfies ConsultToolDetails,
          };
        }
        const hasText = outcome.text !== undefined && outcome.text.trim().length > 0;
        const outcomeTag = outcomeLabel(outcome, capReason);
        if (!hasText) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Expert "${expertName(ref)}" did not answer within ${Math.round(s.timeoutMs / 1000)}s ` +
                  `(consult run ${outcome.runId}, reason: ${humanReason(outcome, capReason, s.timeoutMs)}). ` +
                  "Fall back to your own investigation.",
              },
            ],
            ...usage,
            details: { ...baseDetails, outcome: outcomeTag } satisfies ConsultToolDetails,
          };
        }
        const truncated = truncateResultText(outcome.text!, s.maxAnswerChars);
        return {
          content: [
            {
              type: "text" as const,
              text: `${truncated.text}\n\n⚠ partial answer — consult ended early (${humanReason(outcome, capReason, s.timeoutMs)}).`,
            },
          ],
          ...usage,
          details: {
            ...baseDetails,
            truncated: truncated.truncated,
            partial: true,
            outcome: outcomeTag,
          } satisfies ConsultToolDetails,
        };
      } finally {
        // Rejection paths above return through here too — the gate is always
        // released (T-2: "nack 后并发计数已释放").
        deps.inflight.release(deps.selfRunId);
      }
    },
  };
}
