import { existsSync, statSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConsultExpertRef, RunId, RunSnapshot } from "../core/types.js";
import type { ConsultSettings } from "../config/settings.js";
import type { QueryService } from "../service/query-service.js";
import type { SpawnService } from "../service/spawn-service.js";
import { matchRunId, type ResolveTargetDeps } from "../service/resolve-target.js";
import { createExpertIndex, isUnderDir, type ExpertIndex } from "./expert-index.js";
import {
  CONSULT_MAX_GLOBAL_INFLIGHT,
  createConsultSpawnPort,
  createConsultTool,
  type ConsultForkStore,
} from "./tool.js";

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
  /** Agent-tool `experts` admission resolver — throws a config error on any failure (§4.2). */
  resolveExperts(refs: readonly string[]): ResolveExpertsResult;
  /** Per-run consult-tool factory for the runtime adapter; undefined when disabled/whitelist empty. */
  depsFactory(selfRunId: RunId, selfCwd: string, whitelist: readonly ConsultExpertRef[]): ToolDefinition | undefined;
  /** Fork-dir TTL sweep (stack calls it synchronously at build; no timer is ever created). */
  sweep(): void;
  /** Runner/adapter physical-reap callback — deletes the fork copy, consult-dir scoped, idempotent (§4.4). */
  onReaped(runId: RunId, forkSessionFrom?: string): void;
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
  const expertIndex = createExpertIndex({ consultDir });
  if (deps.prefetchedEntries) expertIndex.rebuildFromEntries(deps.prefetchedEntries);

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
  ): { ref?: ConsultExpertRef; warning?: string; failure?: string } {
    const record = expertIndex.list().find((r) => r.runId === runId);
    const sessionFile = liveSnap?.diag.sessionFile ?? record?.sessionFile;
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
    const ctx = liveSnap?.diag.contextUsage;
    // A live `percent: null` is an explicit "unknown" measurement: do not
    // resurrect a stale dispatch-time percentage and accidentally nack a
    // consult (plan §4.1 / review-2 #15③). Tokens may fall back because the
    // cost pre-check explicitly permits the dispatch snapshot fallback.
    const percent = ctx !== undefined ? ctx.percent : record?.contextPercent;
    const tokens = ctx?.tokens ?? record?.contextTokens;
    const label = liveSnap?.diag.label ?? record?.label;
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
      },
      ...(pending ? { warning: `⚠ expert "${handle}" is still running; consult will nack until it finishes.` } : {}),
    };
  }

  function resolveExperts(refs: readonly string[]): ResolveExpertsResult {
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
        forkStore,
        priceOf: deps.priceOf,
        inflight,
        settings,
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
    onReaped(runId, forkSessionFrom) {
      if (forkSessionFrom === undefined) return; // not a consult run
      // Defense in depth: only ever delete files the consult subsystem owns.
      if (!isUnderDir(consultDir, forkSessionFrom)) return;
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

export type { ConsultForkStore, ConsultSpawnPort } from "./tool.js";
export { buildConsultPrompt } from "./prompt.js";
export type { ForkExpertSessionResult } from "../core/types.js";
