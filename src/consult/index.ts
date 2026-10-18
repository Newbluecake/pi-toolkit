import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isExternalSessionPath } from "../external-agent/paths.js";
import { msgExpertIsExternal } from "../external-agent/messages.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  CONSULT_MAIN_AGENT_TYPE,
  CONSULT_MAIN_EXPERT_ID,
  type ConsultExpertRef,
  type RunId,
  type RunSnapshot,
} from "../core/types.js";
import type { ConsultSettings } from "../config/settings.js";
import type { QueryService } from "../service/query-service.js";
import type { SpawnService } from "../service/spawn-service.js";
import { matchRunId, type ResolveTargetDeps } from "../service/resolve-target.js";
import { createExpertIndex, isUnderDir, summarizeExpertTask, type ExpertIndex } from "./expert-index.js";
import {
  CONSULT_MAX_GLOBAL_INFLIGHT,
  createConsultSpawnPort,
  createConsultTool,
  type ConsultAskerCwd,
  type ConsultForkStore,
} from "./tool.js";
import type { MainSessionFactsProvider } from "./main-facts.js";
import { releaseConsultGuard } from "./preserve-guard.js";
import { createConsultThreads, type ConsultThreads } from "./threads.js";
import { createAnchorLedger, type AnchorLedger } from "./anchor-ledger.js";
import type { ConsultDisplayMeta } from "./tool.js";

/**
 * consult assembly (docs/dev/consult/plan.md §6 C-11): everything mutable
 * (per-asker + global concurrency counters, the owned-runId set, the watcher
 * registry, the ExpertIndex) lives inside this closure — rebuilt per
 * `buildSessionStack`, never at module scope (/reload invariant).
 */

/** Dispatch-time expert resolution outcome (§4.2): success carries echo lines; every failure throws. */
export interface ResolveExpertsResult {
  /** Resolved refs in the dispatcher's order; becomes SpawnRequest.consultExperts (trusted). */
  refs: ConsultExpertRef[];
  /** One echo line per input handle, e.g. `expert "X" → run_id r_ABC (explorer)` (review-2 #9). */
  lines: string[];
  /** Warnings (still-running experts accepted as pending). */
  warnings: string[];
}

export interface ConsultWiring {
  expertIndex: ExpertIndex;
  /**
   * Agent-tool `experts` admission resolver — throws a config error on any
   * failure (§4.2). `opts.completedOnly` (workflow-experts plan §3 D8 /
   * §4.3, opt-in) restricts acceptance to `completed` runs with a
   * persisted session file; omitted/false keeps top-level `Agent` behavior
   * byte-identical (failed/aborted/timed_out runs still accepted).
   */
  resolveExperts(refs: readonly string[], opts?: { completedOnly?: boolean }): ResolveExpertsResult;
  /** Per-run consult-tool factory for the runtime adapter; undefined when disabled/whitelist empty. */
  depsFactory(
    selfRunId: RunId,
    selfCwd: () => ConsultAskerCwd,
    whitelist: readonly ConsultExpertRef[],
  ): ToolDefinition | undefined;
  /** Fork-dir TTL sweep (stack calls it synchronously at build; no timer is ever created). */
  sweep(): void;
  /**
   * Runner/adapter physical-reap callback — deletes the fork copy, consult-dir scoped, idempotent (§4.4).
   * `info.disposed` is the R2-1 seal proof: only a positively disposed session can let a thread retain
   * its fork file instead of deleting it; absent/false ⇒ delete (legacy behaviour).
   */
  onReaped(runId: RunId, forkSessionFrom?: string, info?: { disposed: boolean }): void;
  /** Take-once display metadata for a consult run keyed by its fork path (runtime-adapter `consultDisplayMeta` dep). */
  takeDisplayMeta(forkSessionFrom: string): ConsultDisplayMeta | undefined;
  /** Follow-up threads (cache-thread plan §4) — exposed for lifecycle wiring and tests. */
  readonly threads: ConsultThreads;
  /** Proven-touch ledger behind the pre-consult warm/cold prediction (§5.1). */
  readonly anchorLedger: AnchorLedger;
  /**
   * §7: idempotent teardown — closes threads (deletes every head and reaped candidate; late callbacks only
   * delete), clears the ledger and pending metadata. Called from session_shutdown, the session_start
   * defensive cleanup and the next `buildSessionStack`. Never throws; no timers exist to cancel.
   */
  close(): void;
  /** Stack onSnapshot tap → cap-watcher fan-out (no timer; purely snapshot-driven). */
  dispatchSnapshot(snapshot: RunSnapshot): void;
}

export interface WireConsultDeps {
  settings: () => ConsultSettings;
  query: QueryService;
  /** The process's spawn service (only spawn/waitOutcome/abort are reached, via the narrow port). */
  spawnService: Pick<SpawnService, "spawn" | "waitOutcome" | "abort">;
  /**
   * Unit prices ($/M tok) incl. `ModelCost.tiers` selection — implemented in
   * stack.ts over pi's typed model registry (review-3 #7②); undefined price
   * simply disables the cost pre-check.
   */
  priceOf: (
    model: { provider: string; id: string },
    contextTokens: number,
  ) => { input: number; cacheWrite: number } | undefined;
  /** Fork-file store (package B). Injected so package C compiles/tests standalone. */
  forkStore: ConsultForkStore;
  /** Fork-file directory (the structural consult-run marker + deletion scope). */
  consultDir: string;
  /** Main-session prefetched entries for the initial ExpertIndex rebuild. */
  prefetchedEntries?: readonly unknown[];
  /**
   * consult (plan §16 "consult the main session"): live facts about the
   * HOST main session, read fresh on every `experts:["main"]` dispatch-time
   * resolution AND on every actual `consult("main", …)` call (never cached
   * — rule 3/4). Absent ⇒ "main" always fails to resolve with "no persisted
   * session" (safe default; production wiring is stack.ts over the
   * session's own `ExtensionContext`, mirroring the HUD footer precedent).
   */
  mainSessionFacts?: MainSessionFactsProvider;
  /**
   * external-agent plan §5.4 (P4b): provider-claim predicate, injected by P5
   * only when the external port exists (`(p) => port.owns(p)`). Absent ⇒ a pi
   * run whose model's provider literally reads "droid" is NOT treated as
   * external (byte-identical pre-feature behavior — review #7).
   */
  isExternalProvider?: (provider: string) => boolean;
  /** pi-ai api of a model route (warm/cold prediction needs `anthropic-messages`). */
  routeApi?: (model: { provider: string; id: string }) => string | undefined;
  /** Test seams: time source and epoch id. */
  now?: () => number;
  epoch?: string;
}

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function wireConsult(deps: WireConsultDeps): ConsultWiring {
  const { settings, query, forkStore, consultDir } = deps;
  // external-agent plan §5.4 (P4b): the agent dir, derived from `consultDir`
  // (= `<agentDir>/cache/consult-sessions`, the frozen `consultSessionDir()`
  // contract) so the structural external-session check needs no extra dep.
  const agentDir = dirname(dirname(consultDir));
  const expertIndex = createExpertIndex({ consultDir });
  if (deps.prefetchedEntries) expertIndex.rebuildFromEntries(deps.prefetchedEntries);
  // consult (plan §16): read fresh on every call, never cached here — see
  // main-facts.ts for why a stale reading would be wrong.
  const mainFacts: MainSessionFactsProvider = deps.mainSessionFacts ?? (() => ({}));
  /** §16 rules 2/4: resolve the reserved "main" handle from LIVE host facts, never a cached snapshot. */
  function buildMainRef(): { ref?: ConsultExpertRef; failure?: string } {
    const facts = mainFacts();
    const sessionFile = facts.sessionFile;
    if (sessionFile === undefined || sessionFile.length === 0) {
      return {
        failure:
          "the host main session has no persisted session file (it was started with --no-session) — " +
          "resume-free consult needs a session file",
      };
    }
    if (!fileExists(sessionFile)) {
      return { failure: `the host main session's file no longer exists on disk (${sessionFile})` };
    }
    return {
      ref: {
        runId: CONSULT_MAIN_EXPERT_ID,
        label: CONSULT_MAIN_EXPERT_ID,
        sessionFile,
        agentType: CONSULT_MAIN_AGENT_TYPE,
        kind: "main",
        ...(facts.model !== undefined ? { model: facts.model } : {}),
        ...(facts.contextPercent != null ? { contextPercent: facts.contextPercent } : {}),
        ...(facts.contextTokens != null ? { contextTokens: facts.contextTokens } : {}),
      },
    };
  }

  // ── Concurrency gate (§4.1 ②): per-asker cap (settings) + global cap
  // (constant 8). Plain closure counters, rebuilt with the stack.
  const perAsker = new Map<RunId, number>();
  let globalInflight = 0;
  const inflight = {
    tryAcquire(selfRunId: RunId): boolean {
      if (globalInflight >= CONSULT_MAX_GLOBAL_INFLIGHT) return false;
      const current = perAsker.get(selfRunId) ?? 0;
      if (current >= settings().maxConcurrent) return false;
      perAsker.set(selfRunId, current + 1);
      globalInflight += 1;
      return true;
    },
    release(selfRunId: RunId): void {
      const current = perAsker.get(selfRunId);
      if (current === undefined) return; // idempotent
      if (current <= 1) perAsker.delete(selfRunId);
      else perAsker.set(selfRunId, current - 1);
      globalInflight = Math.max(0, globalInflight - 1);
    },
  };

  // ── Owned-runId bookkeeping + watcher registry for the narrow port
  // (review-2 #1: waitOutcome/abortRun/watchRun only serve this port's runs).
  const owned = new Set<RunId>();
  const watchers = new Map<RunId, Set<(snapshot: RunSnapshot) => void>>();
  const dispatchSnapshot = (snapshot: RunSnapshot): void => {
    // R2-2: an asker reaching a terminal state closes its threads (gen+1, heads deleted).
    if (TERMINAL.has(snapshot.status)) threads.onRunTerminal(snapshot.runId);
    const set = watchers.get(snapshot.runId);
    if (set === undefined) return;
    for (const cb of [...set]) {
      try {
        cb(snapshot);
      } catch (err) {
        console.warn(
          `[pi-subagent] consult watcher for run ${snapshot.runId} failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  const port = createConsultSpawnPort({ spawnService: deps.spawnService, owned, watchers });

  // ── cache-thread plan: threads + prediction ledger + take-once display meta (closure state only).
  const now = deps.now ?? Date.now;
  const epoch = deps.epoch ?? `ce_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const threads = createConsultThreads({
    epoch,
    now,
    fs: {
      size(path) {
        try {
          const st = statSync(path);
          return st.isFile() ? st.size : undefined;
        } catch {
          return undefined;
        }
      },
      remove(path) {
        // Defense in depth, same scope check as onReaped: only files this subsystem owns.
        if (!isUnderDir(consultDir, path)) return;
        try {
          forkStore.removeForkFile(path);
        } catch {
          /* idempotent cleanup never throws */
        }
      },
    },
  });
  const anchorLedger = createAnchorLedger({ now });
  const pendingMeta = new Map<string, ConsultDisplayMeta>();
  const displayMeta = {
    put(forkPath: string, meta: ConsultDisplayMeta): void {
      pendingMeta.set(forkPath, meta);
    },
    drop(forkPath: string): void {
      pendingMeta.delete(forkPath);
    },
  };
  let closed = false;

  // ── Dispatch-time resolution (§4.2/§4.5): live (query) ∪ index, same
  // label across sources with different runIds → ambiguous throw.
  const liveCandidates = (): RunSnapshot[] =>
    // Structural consult-run exclusion applies to the live path too (fork
    // copies live under consultDir; a consult run is never an expert).
    query.list().filter((snap) => {
      const file = snap.diag.sessionFile;
      return file === undefined || !isUnderDir(consultDir, file);
    });
  const liveResolveDeps = (candidates: readonly RunSnapshot[]): ResolveTargetDeps => ({
    records: () => [...candidates],
    liveSnapshots: [],
    labels: new Map(),
    tombstones: { list: () => [], get: () => undefined },
  });
  const describeCandidate = (runId: RunId): string => {
    const live = query.list().find((s) => s.runId === runId);
    const label = live?.diag.label ?? expertIndex.list().find((r) => r.runId === runId)?.label;
    return label !== undefined ? `"${label}" (${runId})` : runId;
  };
  const candidateList = (): string => {
    const entries: string[] = [];
    for (const snap of liveCandidates()) {
      if (snap.diag.sessionFile === undefined && !TERMINAL.has(snap.status)) continue;
      entries.push(describeCandidate(snap.runId));
    }
    for (const record of expertIndex.list()) {
      if (!entries.some((e) => e.includes(record.runId))) entries.push(describeCandidate(record.runId));
    }
    return entries.slice(0, 12).join(", ");
  };
  const ambiguousError = (handle: string, runIds: readonly RunId[]): Error =>
    new Error(
      `consult: ambiguous expert "${handle}" — it matches multiple runs: ${runIds
        .map((id) => describeCandidate(id))
        .join(
          " and ",
        )}. Use the full run_id to disambiguate (this happens when the same label was reused across reloads).`,
    );

  function buildRef(
    handle: string,
    runId: RunId,
    liveSnap: RunSnapshot | undefined,
    opts?: { completedOnly?: boolean },
  ): { ref?: ConsultExpertRef; warning?: string; failure?: string } {
    const record = expertIndex.list().find((r) => r.runId === runId);
    const sessionFile = liveSnap?.diag.sessionFile ?? record?.sessionFile;
    const model = liveSnap?.diag.model ?? record?.model;
    // external-agent plan §5.4 (P4b): a droid external run is never a
    // consultable expert — structural evidence only (review #7): the run's
    // external diag, the session file's location under <agentDir>/external-agent/,
    // or the injected provider predicate (only present when the port exists).
    if (
      liveSnap?.diag.external !== undefined ||
      isExternalSessionPath(sessionFile, agentDir) ||
      (model?.provider !== undefined && deps.isExternalProvider?.(model.provider) === true)
    ) {
      return { failure: msgExpertIsExternal(runId) };
    }
    if (sessionFile === undefined || sessionFile.length === 0) {
      return {
        failure:
          `its run has no persisted session (agent type runs without persisted sessions when ` +
          `rememberAgents=false) — resume-free consult needs the session file`,
      };
    }
    if (!fileExists(sessionFile)) {
      return { failure: `its session file no longer exists on disk (${sessionFile})` };
    }
    const agentType = liveSnap?.diag.agentType ?? record?.agentType ?? "";
    if (agentType.length === 0) return { failure: "its run record carries no agent type" };
    const pending = liveSnap !== undefined && !TERMINAL.has(liveSnap.status);
    if (opts?.completedOnly === true) {
      // workflow-experts plan §3 D8 / §4.3: workflow-local resolution only
      // ever accepts `completed` runs with a persisted session — failed/
      // timed_out/aborted and still-running are all rejected, with the
      // reason spelled out (D8's rationale: a failed/aborted upstream's
      // session is often a half-finished conclusion, and an un-awaited
      // running run is most likely a script bug). Top-level `Agent` never
      // passes this option, so its behavior stays byte-identical.
      if (pending) return { failure: "is still running (await it first)" };
      const status = liveSnap?.status ?? record?.status;
      if (status !== "completed") {
        return {
          failure: `its run ended as ${status ?? "unknown"} (workflow experts must be completed runs)`,
        };
      }
    }
    const ctx = liveSnap?.diag.contextUsage;
    // A live `percent: null` is an explicit "unknown" measurement: do not
    // resurrect a stale dispatch-time percentage and accidentally nack a
    // consult (plan §4.1 / review-2 #15③). Tokens may fall back because the
    // cost pre-check explicitly permits the dispatch snapshot fallback.
    const percent = ctx !== undefined ? ctx.percent : record?.contextPercent;
    const tokens = ctx?.tokens ?? record?.contextTokens;
    const label = liveSnap?.diag.label ?? record?.label;
    const task = summarizeExpertTask(liveSnap?.diag.taskPrompt) ?? record?.task;
    return {
      ref: {
        runId,
        ...(label !== undefined && label.length > 0 ? { label } : {}),
        sessionFile,
        agentType,
        ...(liveSnap?.diag.model !== undefined
          ? { model: liveSnap.diag.model }
          : record?.model !== undefined
            ? { model: record.model }
            : {}),
        ...(percent != null ? { contextPercent: percent } : {}),
        ...(tokens !== undefined ? { contextTokens: tokens } : {}),
        ...(pending ? { pending: true } : {}),
        ...(task !== undefined ? { task } : {}),
      },
      ...(pending ? { warning: `⚠ expert "${handle}" is still running; consult will nack until it finishes.` } : {}),
    };
  }

  function resolveExperts(refs: readonly string[], opts?: { completedOnly?: boolean }): ResolveExpertsResult {
    if (!settings().enabled)
      throw new Error('consult is disabled (consult.enabled=false); remove "experts" or enable it');
    const live = liveCandidates();
    const liveIds = liveResolveDeps(live);
    const resolved: ConsultExpertRef[] = [];
    const lines: string[] = [];
    const warnings: string[] = [];
    const failures: string[] = [];
    for (const handle of refs) {
      const trimmed = handle.trim();
      // §16 rule 2: the reserved "main" handle is checked FIRST, taking
      // priority over any real run/label that happens to share the name —
      // it never falls through to the id/label union logic below.
      if (trimmed === CONSULT_MAIN_EXPERT_ID) {
        const built = buildMainRef();
        if (built.failure !== undefined) {
          failures.push(`expert "${CONSULT_MAIN_EXPERT_ID}": ${built.failure}`);
          continue;
        }
        resolved.push(built.ref!);
        lines.push(`expert "${CONSULT_MAIN_EXPERT_ID}" → the host main session`);
        continue;
      }
      // 1) id path: live and index both do exact → unique-prefix (matchRunId
      //    semantics on both sides); union of runIds >1 → ambiguous.
      const liveMatch = matchRunId(trimmed, liveIds);
      const indexMatch = expertIndex.resolveId(trimmed);
      const ids = new Set<RunId>();
      if (liveMatch.runId !== undefined) ids.add(liveMatch.runId);
      if (indexMatch.ok) ids.add(indexMatch.record.runId);
      if (liveMatch.ambiguous) {
        const ambiguous = live.filter((s) => s.runId === trimmed || s.runId.startsWith(trimmed)).map((s) => s.runId);
        for (const id of ambiguous) ids.add(id);
      }
      if (!indexMatch.ok && indexMatch.ambiguous !== undefined) {
        for (const id of indexMatch.ambiguous) ids.add(id);
      }
      if (ids.size > 1) throw ambiguousError(trimmed, [...ids]);
      let hit: { ref?: ConsultExpertRef; warning?: string; failure?: string } | undefined;
      if (ids.size === 1) {
        const runId = [...ids][0]!;
        hit = buildRef(
          trimmed,
          runId,
          live.find((s) => s.runId === runId),
          opts,
        );
      } else {
        // 2) label path (id missed): live labels ∪ index labels, dedup by
        //    runId; >1 → ambiguous (reload generations can share a label).
        const labelIds = new Set<RunId>();
        for (const snap of live) {
          if (snap.diag.label === trimmed && snap.diag.sessionFile !== undefined) labelIds.add(snap.runId);
        }
        for (const record of expertIndex.findByLabel(trimmed)) labelIds.add(record.runId);
        if (labelIds.size > 1) throw ambiguousError(trimmed, [...labelIds]);
        if (labelIds.size === 1) {
          const runId = [...labelIds][0]!;
          hit = buildRef(
            trimmed,
            runId,
            live.find((s) => s.runId === runId),
            opts,
          );
        }
      }
      if (hit === undefined) {
        failures.push(
          `expert "${trimmed}": no finished run with a persisted session matches (label or run_id) — ` +
            `candidates: ${candidateList() || "none"}`,
        );
        continue;
      }
      if (hit.failure !== undefined) {
        failures.push(`expert "${trimmed}": ${hit.failure}`);
        continue;
      }
      if (hit.ref === undefined) {
        failures.push(`expert "${trimmed}": resolution failed`);
        continue;
      }
      resolved.push(hit.ref);
      lines.push(`expert "${trimmed}" → run_id ${hit.ref.runId} (${hit.ref.agentType})`);
      if (hit.warning !== undefined) warnings.push(hit.warning);
    }
    if (failures.length > 0) {
      throw new Error(
        `consult: could not resolve the expert whitelist — ${failures.join("; ")}. ` +
          "Fix the experts list (labels or run_ids of finished, persisted runs) and re-dispatch.",
      );
    }
    return { refs: resolved, lines, warnings };
  }

  return {
    expertIndex,
    resolveExperts,
    depsFactory(selfRunId, selfCwd, whitelist) {
      if (!settings().enabled) return undefined;
      if (whitelist.length === 0) return undefined;
      return createConsultTool({
        selfRunId,
        selfCwd,
        whitelist,
        port,
        query,
        expertSettledAt: (runId) => {
          const live = query.get(runId)?.diag.settledAt;
          if (typeof live === "number") return live;
          return expertIndex.list().find((record) => record.runId === runId)?.settledAt;
        },
        forkStore,
        priceOf: deps.priceOf,
        inflight,
        settings,
        mainSessionFacts: mainFacts,
        threads,
        anchorLedger,
        displayMeta,
        now,
        ...(deps.routeApi === undefined ? {} : { routeApi: deps.routeApi }),
      });
    },
    sweep() {
      try {
        forkStore.sweepForkDir?.();
      } catch (err) {
        console.warn(
          `[pi-subagent] consult fork-dir sweep failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    takeDisplayMeta(forkSessionFrom) {
      const meta = pendingMeta.get(forkSessionFrom);
      pendingMeta.delete(forkSessionFrom);
      return meta;
    },
    threads,
    anchorLedger,
    close() {
      if (closed) return;
      closed = true;
      try {
        threads.close();
      } catch (err) {
        console.warn(
          `[pi-subagent] consult thread close failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      anchorLedger.close();
      pendingMeta.clear();
    },
    onReaped(runId, forkSessionFrom, info) {
      releaseConsultGuard(runId);
      if (forkSessionFrom === undefined) return; // not a consult run
      // Defense in depth: only ever delete files the consult subsystem owns.
      if (!isUnderDir(consultDir, forkSessionFrom)) return;
      // R2-1: a thread may retain the file ONLY when the session is proven disposed; a retained
      // head is never deleted here, not even by a duplicate callback.
      if (threads.onReaped(forkSessionFrom, info) === "keep") return;
      try {
        forkStore.removeForkFile(forkSessionFrom); // ENOENT-silent ⇒ idempotent
      } catch (err) {
        console.warn(
          `[pi-subagent] consult fork cleanup for run ${runId} failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    dispatchSnapshot,
  };
}

export type { ConsultAskerCwd, ConsultForkStore, ConsultSpawnPort } from "./tool.js";
export { buildConsultPrompt, consultPromptLists } from "./prompt.js";
export { buildCacheProbe } from "./tool.js";
export { scanExpertSnapshot } from "./fork-store.js";
export type { ForkExpertSessionResult } from "../core/types.js";
export type { MainSessionFacts, MainSessionFactsProvider } from "./main-facts.js";
