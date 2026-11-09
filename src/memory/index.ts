import {
  createIncrementalScheduler,
  type IncrementalBatchHandler,
  type IncrementalDirectory,
  type IncrementalBatch,
} from "./govern/incremental.js";
import { readIncrementalCorpus } from "./govern/incremental-corpus.js";
import { isExternalWriteOrigin } from "./govern/write-origin.js";
import { createMemoryDispatcher } from "./unified/dispatcher.js";
import type { MemoryScopesWiring } from "./scopes/wire.js";
import { createScopedProjection } from "./scoped-projection.js";
import type { SystemPromptMode } from "../sysprompt/hub.js";
/**
 * Entry contract for the merged armory-memory module (merge-plan D6):
 * `wireMemory(pi, opts)` registers the `pi_project_memory` section into the
 * shared `PromptSectionHub`, the `memory` tool, and the `/mem` command. It
 * does NOT read settings — the `memory.enabled` gate lives at the call site
 * (src/index.ts, pre-guard so child sessions keep injection, §4.1).
 *
 * M3 (sysprompt-stable plan §4.6/§7.1): memory no longer owns a
 * `before_agent_start` hook of its own — it registers a `SectionRegistration`
 * (src/memory/inject.ts `memorySection`) into the hub created by
 * `src/index.ts` before this call, so the hub's single pre-guard handler
 * folds memory -> agent types -> models in one pass (same order pre-M3
 * produced by chaining separate hooks).
 *
 * todo #22 optimize-plan P0-b:
 * - `memory.toolSurface` selects `tool.ts` (legacy, unchanged, §2.7 复审
 *   新-3) or `tool-v2.ts` (P2's implementation) — defaults are tiered/v2 after P5;
 *   explicit legacy settings preserve the old paths (§9).
 *
 * All mutable state (the RenderCache and the freezeInjectionAfterWrite
 * frozenBlocks map) lives in THIS closure (§5.2/§5.5: no module-scope
 * mutable state). Frozen blocks are per-session: cleared on session_start
 * (`/new` thaws; `/reload` re-activates with a fresh closure anyway), while
 * the fingerprint-keyed RenderCache survives across sessions. P50.1 owns at most
 * one segmented unref timer only when explicitly enabled with a live activity owner.
 */

import type { MemoryWebWritePort } from "./scopes/web-write-port.js";
import type { ExtensionContext, ExtensionToolContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import type { PromptSectionHub } from "../sysprompt/hub.js";
import type { MemoryWriteGate } from "./contracts.js";
import { createSweepRunner, type SweepRender } from "./govern/sweep.js";
import { createGovernanceSignals, type BudgetDirectoryIdentity, type GovernanceSignal } from "./govern/signals.js";
import { createFirstUserReviewHost } from "./jev/first-user-review.js";
import type { BudgetRenderStats } from "./blocks/render.js";
import { readMarker } from "./blocks/marker.js";
import { join } from "node:path";
import { createGovernanceMarkers } from "./govern/markers.js";
import type { SweepReason } from "./govern/sweep-plan.js";
import { createMemCommand } from "./command.js";
import { executeMemoryRead, type MemoryReadResult } from "./command-readonly.js";
import { memorySection, renderExternalMemoryBlock } from "./inject.js";
import { RenderCache, type InjectBudget } from "./render.js";
import { createMemoryTool } from "./tool.js";
import { createMemoryToolV2 } from "./tool-v2.js";
import { createMemoryToolV3, createProjectInspectorV4 } from "./tool-v3.js";
import { renderTiered } from "./tiered.js";
import { createStartupReminder, collectDoctorFindings, type RenderTieredPort } from "./doctor-command.js";
import { summaryLine } from "./doctor.js";
import { canonicalDir, inspectDirSecurityNoFollow, statRegularIfExists } from "./safe-fs.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { dirFormat, effectiveLayout, toolSurfaceFor } from "./blocks/naming.js";
import { runMigration, resumeRollback, plainMemoryWriteGate } from "./blocks/migrate.js";
import { memoryDirFor } from "./paths.js";
import { resolveJevWiring, type JevDomainKind } from "./jev/config.js";
import { wireJev, registryOf } from "./jev/wire.js";
import { createJevWritePort } from "./jev/write-port.js";
import type {
  ClassifierRegistryLike,
  JevClient,
  JevBashJobsLitePort,
  JevDoctorPort,
  JevFleetPort,
  JevRenderInfo,
  JevTodoPort,
} from "./jev/contracts.js";

export interface WireMemoryOpts {
  settings: MemorySettings;
  /** P50.2 registration point. Absent => revision-unavailable, no model/writes. */
  incrementalBatchHandler?: IncrementalBatchHandler;
  /** P50.2 must bind this to the existing JevClient's bounded/cost/zombie admission. */
  incrementalAdmission?: (batch: IncrementalBatch) => boolean;
  scopes?: MemoryScopesWiring;
  systemPromptMode?: () => SystemPromptMode;
  writeGate?: MemoryWriteGate;
  isChildSession: boolean;
  /** The shared PromptSectionHub (sysprompt-stable §4.6) that folds this
   *  section into the system prompt; created by src/index.ts before memory
   *  is wired so registration order == fold order (memory first). */
  sections: PromptSectionHub;
  /** Cross-package P5 ports. Defaults are intentionally absent only for
   *  direct unit callers; production wiring always supplies these. */
  renderBlock?: RenderTieredPort;
  /** jev-plan J6 / I11: the secure-domain verdict (`secureDomain.kind`).
   *  Anything but "plain" keeps Jev unwired. Absent ⇒ "plain". */
  secureDomainKind?: JevDomainKind;
  /** #26 (no-user-guard-confirm plan): the session lifecycle signal getter,
   *  owned by `src/index.ts` (fresh controller per session_start, aborted on
   *  session_shutdown/reload — merged into the MAIN session's existing hook
   *  registrations there, so wiring memory never adds a hook registration;
   *  child sessions are never handed one). The tool concatenates it with the
   *  tool signal per call as the touched>0 commit checkpoint. */
  sessionSignal?: () => AbortSignal | undefined;
  /** memory-predict plan §11.1 signal T — forwarded verbatim to `wireJev`'s
   *  `todo` dep (undefined ⇒ P1b sees an empty todo list). */
  todo?: () => JevTodoPort | undefined;
}

export type MemoryReadPort = (args: string, cwd: string) => MemoryReadResult;

export interface WireMemoryResult {
  /** Read-only Web executor; no native handler or write grant is exposed. */
  readonly webRead: MemoryReadPort;
  readonly webWrite?: MemoryWebWritePort;
  /** external-agent plan §5.6：导出给外部 agent run（droid）的记忆块（子会话视角）。
   *  P5 经 holder 晚绑定给 `ExternalAgentsPort` 的 `memoryBlock` 端口；
   *  `externalAgents.droid.injectMemory=false` 时 P5 干脆不传该端口。 */
  renderForExternal(cwd: string): string | undefined;
  /** memory-predict plan §11.1: `src/index.ts` (post-guard, main session only)
   *  calls this once `activeSubagentRunCount`/bashJobs exist — a no-op when
   *  Jev is unwired (off/child-gated) since there's nothing to attach to. */
  attachJevPredictPorts(ports: { bashJobs: JevBashJobsLitePort; fleet: JevFleetPort }): void;
}

/** Q34 (jev-plan J7): a non-empty classifiers list that parsed to zero valid
 *  entries — one plain-English startup-reminder line. */
export function jevSettingsWarnings(settings: MemorySettings, verdict: ReturnType<typeof resolveJevWiring>): string[] {
  if (verdict.on || verdict.reason !== "empty-list") return [];
  const rejected = settings.jev.classifiersRejected;
  return rejected.length === 0
    ? []
    : [`memory.jev.classifiers: all entries invalid (${rejected.join(", ")}) — jev off`];
}

export function wireMemory(pi: ExtensionAPI, opts: WireMemoryOpts): WireMemoryResult {
  // Scopes-on child content is unconditionally readonly, even with an old allow=true setting.
  if (opts.scopes && opts.isChildSession)
    opts = { ...opts, settings: { ...opts.settings, allowWriteInChildSessions: false } };
  const cache = new RenderCache();
  const frozenBlocks = new Map<string, string | undefined>();
  const lastBlocks = new Map<string, string | undefined>();
  const tieredRender = opts.renderBlock ?? renderTiered;
  const budget: InjectBudget = {
    inlineMax: opts.settings.inlineMax,
    byteCap: opts.settings.byteCap,
    indexMax: opts.settings.indexMax,
  };
  // jev-plan §1.1: settings-period wiring verdict. off ⇒ nothing below
  // changes (no hooks, no ports, no extra render work — I9).
  const jevVerdict = resolveJevWiring(opts.settings, opts.secureDomainKind ?? "plain");
  const jevOn = jevVerdict.on;
  const afterWriteHooks: ((cwd: string) => void)[] = [];
  const renderInfos = new Map<string, JevRenderInfo>();
  // §5.5: freeze=false → invalidate so the next turn re-renders (one cache
  // miss); freeze=true → capture the pre-write block (peek miss ⇒ freeze to
  // "no block", R3) so the injected bytes stay stable for this session and
  // the write takes effect next session.
  const sweepRunners = new Map<string, ReturnType<typeof createSweepRunner>>();
  let governanceNotify: ((message: string) => void) | undefined;
  type GovernanceEpoch = {
    cwd: string;
    identity: BudgetDirectoryIdentity;
    key: string;
    controller: AbortController;
    signals: ReturnType<typeof createGovernanceSignals>;
    review?: ReturnType<typeof createFirstUserReviewHost>;
    reviewActive?: boolean;
    latestBudget?: BudgetRenderStats;
    externalPending?: boolean;
  };
  let governanceEpoch: GovernanceEpoch | undefined;
  let governanceSessionActive = false;
  const sweepInvalidation = new Set<string>();
  const revokeGovernance = (): void => {
    governanceEpoch?.controller.abort();
    governanceEpoch?.signals.dispose();
    governanceEpoch?.review?.dispose();
    governanceEpoch = undefined;
    sweepInvalidation.clear();
    sweepRunners.clear();
  };
  const identityFor = (cwd: string): BudgetDirectoryIdentity | undefined => {
    if (
      !opts.settings.enabled ||
      !opts.settings.governance.enabled ||
      opts.isChildSession ||
      opts.secureDomainKind === "locked"
    )
      return undefined;
    const dir = memoryDirFor(resolveWorktreeOrigin(cwd) ?? cwd);
    if (!gate.check(dir).ok) return undefined;
    const canonical = canonicalDir(dir);
    if (!canonical || dirFormat(canonical.real) !== "blocks") return undefined;
    try {
      const parent = inspectDirSecurityNoFollow(canonical.real);
      inspectDirSecurityNoFollow(join(canonical.real, "blocks"));
      const marker = readMarker(join(canonical.real, "blocks"));
      return {
        realpath: canonical.real,
        dev: parent.dev,
        ino: parent.ino,
        ...(marker?.source === "migrate" && marker.gen !== undefined && marker.runId
          ? { migration: { gen: marker.gen, runId: marker.runId } }
          : {}),
      };
    } catch {
      return undefined;
    }
  };
  const epochFor = (cwd: string): GovernanceEpoch | undefined => {
    const identity = identityFor(cwd);
    if (!governanceSessionActive || !identity || migrationAbort.signal.aborted || opts.sessionSignal?.()?.aborted) {
      revokeGovernance();
      return undefined;
    }
    let blocks: ReturnType<typeof inspectDirSecurityNoFollow>;
    try {
      blocks = inspectDirSecurityNoFollow(join(identity.realpath, "blocks"));
    } catch {
      revokeGovernance();
      return undefined;
    }
    const key = JSON.stringify([identity, blocks.dev, blocks.ino]);
    if (governanceEpoch && (governanceEpoch.key !== key || governanceEpoch.cwd !== cwd)) revokeGovernance();
    if (!governanceEpoch)
      governanceEpoch = { cwd, identity, key, controller: new AbortController(), signals: createGovernanceSignals() };
    return governanceEpoch;
  };
  const epochCurrent = (epoch: GovernanceEpoch): boolean => {
    if (
      governanceEpoch !== epoch ||
      epoch.controller.signal.aborted ||
      migrationAbort.signal.aborted ||
      opts.sessionSignal?.()?.aborted
    )
      return false;
    try {
      const dir = memoryDirFor(resolveWorktreeOrigin(epoch.cwd) ?? epoch.cwd);
      if (!gate.check(dir).ok) return false;
      const canonical = canonicalDir(dir);
      if (!canonical || canonical.real !== epoch.identity.realpath) return false;
      const parent = inspectDirSecurityNoFollow(canonical.real);
      const blocksDir = join(canonical.real, "blocks");
      const b = inspectDirSecurityNoFollow(blocksDir);
      if (parent.dev !== epoch.identity.dev || parent.ino !== epoch.identity.ino || b.dev !== parent.dev) return false;
      if (statRegularIfExists(canonical.real, ".blocks-hold") || !statRegularIfExists(blocksDir, ".layout.json"))
        return false;
      const marker = readMarker(blocksDir);
      const migration =
        marker?.source === "migrate" && marker.gen !== undefined && marker.runId
          ? { gen: marker.gen, runId: marker.runId }
          : undefined;
      const identity = {
        realpath: canonical.real,
        dev: parent.dev,
        ino: parent.ino,
        ...(migration ? { migration } : {}),
      };
      return JSON.stringify([identity, b.dev, b.ino]) === epoch.key;
    } catch {
      return false;
    }
  };
  const epochGate = (epoch: GovernanceEpoch): MemoryWriteGate => ({
    capture: (dir) => gate.capture(dir),
    check: (dir) => (epochCurrent(epoch) ? gate.check(dir) : { ok: false, reason: "identity-changed" }),
  });
  const runFirstReview = (epoch: GovernanceEpoch, registry: ClassifierRegistryLike, client: JevClient): void => {
    if (!epochCurrent(epoch) || !jevOn || epoch.reviewActive) return;
    epoch.review?.dispose();
    const host = createFirstUserReviewHost({
      memDir: epoch.identity.realpath,
      enabled: true,
      jevEnabled: true,
      isChild: false,
      client,
      registry,
      gate: epochGate(epoch),
      signal: epoch.controller.signal,
      isCurrent: () => epochCurrent(epoch),
    });
    epoch.review = host;
    epoch.reviewActive = true;
    void host
      .run()
      .catch(() => {})
      .finally(() => {
        epoch.reviewActive = false;
      });
  };
  const triggerSweep = (
    cwd: string,
    reason: SweepReason,
    origin?: string,
    admittedBudget?: SweepRender,
  ): Promise<import("./govern/sweep.js").SweepResult> | undefined => {
    if (
      !opts.settings.governance.enabled ||
      opts.isChildSession ||
      opts.secureDomainKind === "locked" ||
      !isExternalWriteOrigin(origin)
    )
      return;
    const dir = memoryDirFor(cwd);
    if (!gate.check(dir).ok || dirFormat(dir) !== "blocks") return;
    const epoch = governanceEpoch;
    let runner = sweepRunners.get(dir);
    if (!runner) {
      runner = createSweepRunner({
        enabled: true,
        gate: epoch ? epochGate(epoch) : gate,
        residentBudget: opts.settings.residentBytes,
        ...(governanceNotify
          ? {
              notify: (message: string) => {
                if (!epoch || epochCurrent(epoch)) governanceNotify?.(message);
              },
            }
          : {}),
        onAfterWrite: () => {
          if (!epoch || epochCurrent(epoch)) onAfterWrite(cwd, "sweep");
        },
      });
      sweepRunners.set(dir, runner);
    }
    // The memory-owned controller is replaced/aborted in the earlier existing
    // session hook. The outer session controller is swapped by a later hook;
    // capturing it here would abort a new startup sweep when that hook runs.
    const signals = [migrationAbort.signal, ...(epoch ? [epoch.controller.signal] : [])];
    return runner.runSweep(dir, reason, AbortSignal.any(signals), origin, admittedBudget);
  };
  const consumeOpportunity = (
    cwd: string,
    external: boolean,
    registry?: ClassifierRegistryLike,
    client?: JevClient,
  ): boolean => {
    const epoch = epochFor(cwd);
    if (!epoch || !epochCurrent(epoch)) return false;
    const externalOpportunity = external || epoch.externalPending === true;
    epoch.externalPending = false;
    const events =
      epoch.signals.consumeSignals({ signal: epoch.controller.signal, external: externalOpportunity }) ?? [];
    const budgets = epoch.signals.consumeBudgets(epoch.identity, {
      external: externalOpportunity || events.length > 0,
      signal: epoch.controller.signal,
    });
    const stats = budgets.length ? epoch.latestBudget : undefined;
    const reason: SweepReason | undefined = stats
      ? "budget"
      : events.includes("release")
        ? "release"
        : events.includes("push")
          ? "push"
          : events.includes("task-done")
            ? "task-done"
            : undefined;
    if (reason) {
      const pass = triggerSweep(
        cwd,
        reason,
        undefined,
        stats
          ? {
              residentBytes: stats.resident.usedBytes,
              residentBudget: stats.resident.budgetBytes,
              indexOverflow: stats.index.over,
            }
          : undefined,
      );
      if (!pass) {
        epoch.signals.settleBudgets(budgets, false);
        epoch.signals.deferSignals(events);
      } else
        void pass.then(
          (result) => {
            if (!epochCurrent(epoch)) return;
            epoch.signals.settleBudgets(budgets, result.stopped === "done");
            if (result.stopped !== "done" && result.stopped !== "unchanged") epoch.signals.deferSignals(events);
          },
          () => {
            if (!epochCurrent(epoch)) return;
            epoch.signals.settleBudgets(budgets, false);
            epoch.signals.deferSignals(events);
          },
        );
    }
    if (events.length && registry && client) runFirstReview(epoch, registry, client);
    return reason !== undefined;
  };
  const incrementalActivity = () =>
    opts.settings.incremental.enabled &&
    opts.settings.enabled &&
    opts.settings.governance.enabled &&
    !opts.isChildSession &&
    (opts.secureDomainKind ?? "plain") === "plain" &&
    (opts.settings.scopes.session || opts.settings.scopes.hub)
      ? opts.scopes?.activity?.()
      : undefined;
  let incremental: ReturnType<typeof createIncrementalScheduler> | undefined;
  let incrementalClosed = false;
  let incrementalGeneration = 0;
  let incrementalOwnerDiagnosed = false;
  const resetIncremental = (reason: "abort" | "shutdown" | "reload"): void => {
    incrementalGeneration++;
    incremental?.stop(reason);
    incremental = undefined;
    incrementalClosed = true;
  };
  const incrementalIdentity = (cwd: string): IncrementalDirectory | undefined => {
    if (
      !opts.settings.incremental.enabled ||
      !opts.settings.enabled ||
      !opts.settings.governance.enabled ||
      opts.isChildSession ||
      (opts.secureDomainKind ?? "plain") !== "plain" ||
      incrementalClosed ||
      !governanceSessionActive
    )
      return undefined;
    const runtime = opts.scopes?.current();
    if (!runtime || !incrementalActivity()) {
      if (!incrementalOwnerDiagnosed) {
        incrementalOwnerDiagnosed = true;
        if (!governanceNotify) console.warn("p50: activity owner unavailable; incremental revision disabled");
      }
      return undefined;
    }
    const identity = identityFor(cwd);
    return identity
      ? { realpath: identity.realpath, dev: identity.dev, ino: identity.ino, sessionEpoch: runtime.owner.sessionEpoch }
      : undefined;
  };
  const incrementalFor = (cwd: string) => {
    const identity = incrementalIdentity(cwd);
    if (!identity) return undefined;
    const runtime = opts.scopes!.current()!;
    if (!incremental)
      incremental = createIncrementalScheduler({
        settings: opts.settings.incremental,
        activity: () => (opts.scopes?.current() === runtime ? incrementalActivity() : undefined),
        isCurrent: (expected) => {
          if (
            incrementalClosed ||
            !governanceSessionActive ||
            migrationAbort.signal.aborted ||
            opts.sessionSignal?.()?.aborted ||
            opts.scopes?.current() !== runtime ||
            runtime.owner.sessionEpoch !== expected.sessionEpoch ||
            !gate.check(expected.realpath).ok
          )
            return false;
          const canonical = canonicalDir(expected.realpath);
          if (!canonical || canonical.real !== expected.realpath || dirFormat(canonical.real) !== "blocks")
            return false;
          const stat = inspectDirSecurityNoFollow(canonical.real);
          inspectDirSecurityNoFollow(join(canonical.real, "blocks"));
          return stat.dev === expected.dev && stat.ino === expected.ino;
        },
        readCorpus: readIncrementalCorpus,
        diagnostic: (line) => {
          if (!governanceNotify) console.warn(line);
        },
        ...(jevOn && opts.incrementalBatchHandler ? { handler: opts.incrementalBatchHandler } : {}),
        ...(jevOn && opts.incrementalAdmission ? { canAttempt: opts.incrementalAdmission } : {}),
      });
    return { scheduler: incremental, identity };
  };
  const onAfterWrite = (cwd: string, origin?: string): void => {
    if (opts.settings.incremental.enabled) {
      try {
        incrementalActivity()?.noteMemoryWrite(Date.now());
      } catch {
        resetIncremental("abort");
      }
      if (isExternalWriteOrigin(origin)) {
        const generation = incrementalGeneration;
        // Detached scan never blocks the tool write path. Preserve every write count
        // while selecting only the newest revisions visible at this opportunity.
        queueMicrotask(() => {
          if (generation !== incrementalGeneration) return;
          try {
            const target = incrementalFor(cwd);
            if (!target) return;
            const corpus = readIncrementalCorpus(target.identity);
            if (corpus) target.scheduler.externalWrite(target.identity, corpus, origin);
          } catch {
            resetIncremental("abort");
          }
        });
      }
    }
    if (!isExternalWriteOrigin(origin)) sweepInvalidation.add(cwd);
    else {
      sweepInvalidation.delete(cwd);
      if (jevOn) {
        const epoch = epochFor(cwd);
        if (epoch && epochCurrent(epoch)) epoch.externalPending = true;
        triggerSweep(cwd, "write", origin);
      } else if (!consumeOpportunity(cwd, true)) triggerSweep(cwd, "write", origin);
    }
    if (origin === "migrate" || effectiveLayout(opts.settings.layout, dirFormat(memoryDirFor(cwd))) === "blocks") {
      lastBlocks.delete(cwd);
      cache.delete(cwd);
      frozenBlocks.delete(cwd);
      projectSection?.projectSources.delete(cwd);
      for (const hook of afterWriteHooks) hook(cwd);
      return;
    }
    if (opts.settings.freezeInjectionAfterWrite) {
      // The tiered cache has more dimensions than legacy's InjectBudget. The
      // last provider result is the exact block that was in the prompt, so it
      // is the correct freeze source for either layout (including an explicit
      // "no block" result before the first render).
      projectSection?.projectSources.freeze(cwd);
      frozenBlocks.set(cwd, lastBlocks.has(cwd) ? lastBlocks.get(cwd) : cache.peek(cwd, budget)?.block);
    } else if (effectiveLayout(opts.settings.layout, dirFormat(memoryDirFor(cwd))) === "tiered") {
      lastBlocks.delete(cwd);
    } else {
      cache.delete(cwd);
    }
    for (const hook of afterWriteHooks) hook(cwd);
  };

  const secureGate = opts.writeGate ?? plainMemoryWriteGate;
  const gate: MemoryWriteGate =
    opts.scopes && opts.isChildSession
      ? {
          check: () => ({ ok: false, reason: "locked" }),
          bootstrap: () => ({ ok: false, reason: "locked" }),
          capture() {},
        }
      : secureGate;
  let projectSection: ReturnType<typeof memorySection> | undefined;
  const projection = opts.scopes
    ? createScopedProjection({
        // A scopes shell is also installed in unbound children/reduced hosts. Without
        // an actual group, keep the independent project-memory renderer available.
        // A disposed group still exists: its stale owner must fail closed, not fall back.
        enabled: () => opts.scopes!.group() !== undefined,
        owner: () => opts.scopes?.current()?.owner,
        mode: opts.systemPromptMode ?? (() => "stable"),
        state: opts.sections,
        ...(opts.settings.scopes.session
          ? {
              session: {
                available: (input: import("../sysprompt/hub.js").SectionProviderInput) => {
                  opts.scopes!.context(input.ctx);
                  return opts.scopes!.current()?.capability() === "ok";
                },
                view: () => {
                  const store = opts.scopes!.current()?.session;
                  if (!store) throw Error("E_STALE_SESSION");
                  return store.view();
                },
              },
            }
          : {}),
        ...(opts.settings.scopes.hub
          ? {
              hub: {
                available: (input: import("../sysprompt/hub.js").SectionProviderInput) => {
                  opts.scopes!.context(input.ctx);
                  const r = opts.scopes!.current();
                  return r?.capability() === "ok" && r.hub !== undefined;
                },
                view: () => {
                  const store = opts.scopes!.current()?.hub;
                  if (!store) throw Error("E_STALE_SESSION");
                  return store.view();
                },
              },
            }
          : {}),
      })
    : undefined;
  if (opts.scopes)
    pi.on("session_tree", () => {
      resetIncremental("abort");
      incrementalClosed = false;
      incrementalOwnerDiagnosed = false;
      revokeGovernance();
      projectSection?.projectSources.clear();
      frozenBlocks.clear();
      lastBlocks.clear();
    });
  let migrationAbort = new AbortController();
  if (opts.settings.layout === "blocks" && opts.secureDomainKind !== "locked")
    gate.capture(memoryDirFor(resolveWorktreeOrigin(process.cwd()) ?? process.cwd()));
  pi.on("session_start", async (_event, ctx) => {
    frozenBlocks.clear();
    lastBlocks.clear();
    revokeGovernance();
    governanceSessionActive = true;
    resetIncremental("abort");
    incrementalClosed = false;
    incrementalOwnerDiagnosed = false;
    migrationAbort.abort();
    migrationAbort = new AbortController();
    sweepRunners.clear();
    const controller = migrationAbort;
    const hostSignal = opts.sessionSignal?.();
    const signal = hostSignal ? AbortSignal.any([controller.signal, hostSignal]) : controller.signal;
    const current = (): boolean =>
      migrationAbort === controller &&
      !signal.aborted &&
      memoryDirFor(resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd) === dir;
    // No optional no-op wrapper: an absent UI port is not successful delivery.
    governanceNotify =
      ctx.hasUI && typeof ctx.ui?.notify === "function" ? (message) => ctx.ui.notify(message, "warning") : undefined;
    const notify = governanceNotify;
    // Child/off/locked paths do not probe disk. Reminder admission uses the
    // ACTUAL layout; changing the configured renderer cannot reset migration.
    if (!opts.settings.enabled || opts.isChildSession || opts.secureDomainKind === "locked") return;
    const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
    const dir = memoryDirFor(cwd);
    if (!gate.check(dir).ok || !canonicalDir(dir)) return;
    if (opts.settings.layout !== "blocks" && dirFormat(dir) !== "blocks") return;
    try {
      if (opts.settings.layout === "blocks") await resumeRollback(dir, { gate, signal });
      if (!current()) return;
      // Independent migration-only path, NOT behind triggerSweep's governance
      // switch and NOT the doctor's pre-notify notifiedSessions bookkeeping.
      const markers = createGovernanceMarkers(dir, {
        gate,
        signal,
        isCurrent: current,
        diag: (message) => {
          if (current() && notify) notify(message);
        },
      });
      const remind = async (): Promise<void> => {
        if (!opts.settings.enabled || !opts.settings.doctor.notifyOnStart || !notify || !current()) return;
        await markers.deliverReloadReminder((message) => {
          if (!current() || !ctx.hasUI || typeof ctx.ui?.notify !== "function" || !opts.settings.doctor.notifyOnStart)
            throw new Error("E_NOTIFY_UNAVAILABLE");
          return notify(message);
        });
      };
      await remind();
      // Review uses the actual on-disk layout, even when the configured
      // renderer is still tiered; it never performs migration itself.
      if (current() && dirFormat(dir) === "blocks") {
        const registry = registryOf(ctx);
        const epoch = epochFor(cwd);
        if (epoch && registry && jev) runFirstReview(epoch, registry, jev.client);
      }
      // Keep migration/sweep's original configured-layout admission unchanged.
      if (!current() || opts.settings.layout !== "blocks") return;
      triggerSweep(cwd, "startup");
      if (!jevOn) consumeOpportunity(cwd, true);
      if (!opts.settings.migrate.auto || dirFormat(dir) !== "files") return;
      const result = await runMigration(dir, {
        gate,
        signal,
        diag: (message) => {
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
        },
      });
      if (result.outcome === "committed" && current()) {
        onAfterWrite(cwd, "migrate");
        if (ctx.hasUI)
          ctx.ui.notify(
            `memory: migrated ${result.plan!.report.files.length} files → ${result.plan!.blocks.length} blocks — /mem migrate --report · undo: /mem migrate --rollback`,
            "info",
          );
        await remind();
        const registry = registryOf(ctx);
        const epoch = epochFor(cwd);
        if (epoch && registry && jev) runFirstReview(epoch, registry, jev.client);
      }
    } catch {
      /* bounded migration failure leaves the current files layout usable */
    }
  });
  // jev-plan J7: the production doctor port is created below (wireJev runs
  // after the hub section); the reminder registers here (unchanged order) and
  // reaches it late-bound. Off ⇒ no port and no warnings — byte-identical.
  let jevDoctor: JevDoctorPort | undefined;
  const lateJevDoctor: JevDoctorPort | undefined = jevOn
    ? { extraReminder: (cwd) => jevDoctor?.extraReminder(cwd) ?? [] }
    : undefined;
  const settingsWarnings = jevSettingsWarnings(opts.settings, jevVerdict);
  if (!opts.isChildSession) {
    const reminder = createStartupReminder({
      settings: opts.settings,
      isChildSession: false,
      renderTieredPort: tieredRender,
      ...(lateJevDoctor === undefined ? {} : { jev: lateJevDoctor }),
      ...(settingsWarnings.length === 0 ? {} : { settingsWarnings }),
    });
    pi.on("session_start", reminder.check);
    pi.on("session_shutdown", (event) => {
      governanceSessionActive = false;
      resetIncremental(event.reason === "reload" ? "reload" : "shutdown");
      revokeGovernance();
      migrationAbort.abort();
      if (event.reason === "reload") reminder.reset();
    });
  }
  projectSection = memorySection({
    settings: opts.settings,
    ...(projection ? { projection } : {}),
    isChildSession: opts.isChildSession,
    cache,
    frozenBlocks,
    onRender: (cwd, block, info, resident, budgetStats) => {
      lastBlocks.set(cwd, block);
      if (budgetStats) {
        const epoch = epochFor(cwd);
        if (epoch && epochCurrent(epoch)) {
          const fromSweep = sweepInvalidation.delete(cwd);
          epoch.latestBudget = budgetStats;
          epoch.signals.observeBudget(
            { identity: epoch.identity, stats: budgetStats },
            fromSweep ? "sweep" : "external",
          );
        }
      }
      // #36 P4 (arch §3.3.5): the fourth argument carries this render's
      // resident id → renderKey map — fold its id set into the recorded
      // JevRenderInfo (wire.ts's renderInfoFor overlays the LEDGER ids on
      // top of whatever lands here).
      if (jevOn && info !== undefined) {
        renderInfos.set(cwd, resident === undefined ? info : { ...info, residentBlocks: [...resident.keys()] });
      }
    },
    ...(jevOn ? { stripInlineMeta: true } : {}),
    // 自己不消费，俛 legacy layout 不调用它；tiered 的 `accessFromTools` 计算属于 P1）。
    // 防御地抖错把它包成安全函数：`pi.getActiveTools` 缺失或抛错都降级为 `[]`
    // （同 `context-switch/child.ts:470` 的这个先例）。
    getActiveTools: () => {
      try {
        return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
      } catch {
        return [];
      }
    },
  });
  opts.sections.register("pi_project_memory", projectSection);
  if (projection?.sessionSection) opts.sections.register("pi_session_memory", projection.sessionSection);
  if (projection?.hubSection) opts.sections.register("pi_hub_memory", projection.hubSection);
  // jev-plan J6: Jev hooks register after the hub (src/index.ts creates the
  // hub first) and before the tool/command so the command port exists.
  const jevTodo = opts.todo?.();
  const jev = jevVerdict.on
    ? wireJev(pi, {
        config: jevVerdict.config,
        settings: opts.settings,
        isChildSession: opts.isChildSession,
        dirFor: (cwd) => canonicalDir(memoryDirFor(cwd))?.real,
        getRenderInfo: (cwd) => renderInfos.get(cwd),
        onAfterWriteHook: (fn) => afterWriteHooks.push(fn),
        createWritePort: createJevWritePort,
        // #36 P4 (arch §3.3.5, r3 裁定 8): the R layer reads the hub's
        // PERSISTED pi_project_memory state so snapshot vs. ledger follows
        // the real hub lifecycle (resume/reload/tree restore the snapshot;
        // stale/undefined falls back to this turn's provider output inside
        // wire). `_state` is the hub's existing interface member — the hub
        // itself is untouched.
        // #36 P4 修复轮：生产 writeGate 覆盖 jev 侧车写入（打标/冷却戳/
        // 建议/taxonomy —— writeIndexPatch 逐原语复检）。
        writeGate: secureGate,
        ...(opts.settings.incremental.enabled
          ? {
              activity: incrementalActivity,
              activityWake: () => incremental?.activityChanged(true),
            }
          : {}),
        governance: {
          capture: (cwd, id, candidate) => {
            const epoch = epochFor(cwd);
            if (epoch && epochCurrent(epoch)) epoch.signals.captureCandidate(id, candidate);
          },
          take: (cwd, id, fingerprint) => {
            const epoch = governanceEpoch;
            return epoch && epoch.cwd === cwd && epochCurrent(epoch)
              ? epoch.signals.takeCandidate(id, fingerprint)
              : undefined;
          },
          clear: () => governanceEpoch?.signals.clearCandidates(),
          mark: (cwd, signal: GovernanceSignal) => {
            const epoch = governanceEpoch;
            if (epoch && epoch.cwd === cwd && epochCurrent(epoch)) {
              epoch.signals.markSignal(signal, { success: true, readOnly: false });
              if (signal === "task-done" && opts.settings.incremental.enabled) {
                const target = incrementalFor(cwd);
                target?.scheduler.taskDone(target.identity);
              }
            }
          },
          abort: () => {
            resetIncremental("abort");
            revokeGovernance();
          },
          turnEnd: (cwd, registry, client) => {
            consumeOpportunity(cwd, false, registry, client);
          },
        },
        getSectionSnapshot: () => {
          const s = opts.sections._state("pi_project_memory");
          return s === undefined ? undefined : { snapshot: s.snapshot, stale: s.stale };
        },
        ...(jevTodo === undefined ? {} : { todo: jevTodo }),
        // J8 acceptance #3 "core usage": doctor's D19 (≥80% of coreBytes, not
        // when D02/D03 already flag the primary) as one reminder line.
        coreUsageLine: (cwd) => {
          const d19 = collectDoctorFindings(cwd, undefined, opts.settings, tieredRender, undefined, {
            extraReminder: () => [],
          }).find((f) => f.id === "D19");
          return d19 === undefined ? undefined : `memory: core usage — ${d19.message}`;
        },
      })
    : undefined;
  jevDoctor = jev?.doctorPort;
  const doctorSummary = (cwd: string): string =>
    summaryLine(
      jev === undefined
        ? collectDoctorFindings(cwd, undefined, opts.settings, tieredRender)
        : collectDoctorFindings(cwd, undefined, opts.settings, tieredRender, undefined, jev.doctorPort),
    );
  // #36 P4 (arch §3.4): activate-time surface choice. `toolSurfaceFor`
  // returns v3 for layout:blocks + a blocks/absent/(files+auto) directory —
  // the registration COUNT and NAME stay exactly one `memory` tool (the
  // activate-trace contract).
  const activationFormat = dirFormat(memoryDirFor(resolveWorktreeOrigin(process.cwd()) ?? process.cwd()));
  const surface = toolSurfaceFor(opts.settings, activationFormat, opts.secureDomainKind === "locked");
  const toolCommon = {
    settings: opts.settings,
    isChildSession: opts.isChildSession,
    onAfterWrite,
    ...(opts.scopes ? { writeGate: gate } : {}),
    ...(opts.sessionSignal === undefined ? {} : { sessionSignal: opts.sessionSignal }),
  };
  const blocksDeps = {
    ...toolCommon,
    writeGate: gate,
    doctorSummary,
    ...(surface !== "v3" || jev === undefined ? {} : { jev: jev.makeWritePort() }),
  };
  const projectTool =
    surface === "v3"
      ? createMemoryToolV3(blocksDeps)
      : surface === "v2"
        ? createMemoryToolV2({
            ...toolCommon,
            ...(effectiveLayout(opts.settings.layout, activationFormat) === "tiered"
              ? { renderBlock: tieredRender }
              : {}),
            doctorSummary,
            ...(jev === undefined ? {} : { jev: jev.makeWritePort() }),
          })
        : createMemoryTool({
            settings: opts.settings,
            isChildSession: opts.isChildSession,
            onAfterWrite,
            ...(opts.scopes ? { writeGate: gate } : {}),
          });
  const v4Active = opts.settings.enabled && (opts.secureDomainKind ?? "plain") === "plain" && surface === "v3";
  let v4Registered = false;
  const dispatcher = createMemoryDispatcher({
    project: (...args: Parameters<typeof projectTool.execute>) => projectTool.execute(...args),
    currentScoped: () => opts.scopes?.current()?.tool,
    v4Registration: () => ({ active: v4Active, registered: v4Registered }),
    ...(v4Active
      ? {
          unified: {
            project: {
              run: (id: string, params: unknown, signal: AbortSignal | undefined, ctx: ExtensionToolContext) =>
                projectTool.execute(id, params as never, signal, undefined, ctx),
              inspect: createProjectInspectorV4(blocksDeps),
            },
            // group.runtime is a read-only live handle; unlike current(), it does not swallow getter failures.
            currentScoped: () => {
              const runtime = opts.scopes?.group()?.runtime();
              return runtime ? { inspect: runtime.inspect, dispatch: runtime.tool.dispatch } : undefined;
            },
            child: opts.isChildSession,
            scopesOn: !!opts.scopes,
            jev: jevOn,
          },
        }
      : {}),
  });
  opts.scopes?.attachDispatcher(dispatcher);
  pi.registerTool(dispatcher.v4 ?? (surface === "v3" ? { ...projectTool, execute: dispatcher.project } : projectTool));
  v4Registered = dispatcher.v4 !== undefined;
  pi.registerCommand(
    "mem",
    createMemCommand({
      isChildSession: opts.isChildSession,
      ...(opts.scopes
        ? {
            scopedRouter: opts.scopes.command,
            scopedDoctor: () => opts.scopes?.current()?.doctor.inspect() ?? [],
            contentReadonly: opts.isChildSession,
            contentWriteGate: gate,
          }
        : {}),
      writeGate: gate,
      settings: opts.settings,
      renderBlock: tieredRender,
      onAfterWrite,
      ...(jev === undefined ? {} : { jev: jev.commandPort }),
    }),
  );
  const webWrite: MemoryWebWritePort | undefined =
    !opts.isChildSession &&
    (opts.secureDomainKind ?? "plain") === "plain" &&
    opts.settings.enabled &&
    opts.settings.scopes.session &&
    opts.scopes
      ? {
          start(request, actualCtx) {
            try {
              const runtime = opts.scopes!.current();
              const ctx = actualCtx as ExtensionContext;
              if (runtime && ctx?.sessionManager === runtime.manager && runtime.current())
                return runtime.startWebWrite(request, ctx);
            } catch {
              /* Missing/stale actual context is never replaced with a fabricated one. */
            }
            return {
              accepted: false,
              outcome: {
                ok: false,
                effect: "none",
                code: "E_MEM_CONFIRM_STALE",
                message: "E_MEM_CONFIRM_STALE: 本步未执行。",
                retryable: false,
              },
            };
          },
        }
      : undefined;
  return {
    ...(webWrite ? { webWrite } : {}),
    webRead: (args, cwd) => executeMemoryRead(args, cwd, undefined, opts.settings),
    renderForExternal(cwd: string): string | undefined {
      return renderExternalMemoryBlock({ settings: opts.settings, cache }, cwd);
    },
    attachJevPredictPorts(ports) {
      jev?.attachPredictPorts(ports);
    },
  };
}
