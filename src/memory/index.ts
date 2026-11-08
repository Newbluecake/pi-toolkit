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
 * - `wireMemory` returns `{ attachTidy }`: `src/index.ts` (post-guard, main
 *   session only) calls it once with a `TidyPort` that reads the CURRENT
 *   session stack (same late-bound `holder.current` pattern the rest of
 *   `src/index.ts` uses); `/mem tidy`/`/mem restore` read the attached port
 *   through a closure-local variable, not a module global.
 *
 * All mutable state (the RenderCache and the freezeInjectionAfterWrite
 * frozenBlocks map) lives in THIS closure (§5.2/§5.5: no module-scope
 * mutable state). Frozen blocks are per-session: cleared on session_start
 * (`/new` thaws; `/reload` re-activates with a fresh closure anyway), while
 * the fingerprint-keyed RenderCache survives across sessions. No timers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import type { PromptSectionHub } from "../sysprompt/hub.js";
import type { MemoryWriteGate, TidyPort } from "./contracts.js";
import { createSweepRunner } from "./govern/sweep.js";
import type { SweepReason } from "./govern/sweep-plan.js";
import { createMemCommand } from "./command.js";
import { executeMemoryRead, type MemoryReadResult } from "./command-readonly.js";
import { memorySection, renderExternalMemoryBlock } from "./inject.js";
import { RenderCache, type InjectBudget } from "./render.js";
import { createMemoryTool } from "./tool.js";
import { createMemoryToolV2 } from "./tool-v2.js";
import { createMemoryToolV3 } from "./tool-v3.js";
import { renderTiered } from "./tiered.js";
import { runDoctor } from "./doctor.js";
import { createStartupReminder, collectDoctorFindings, type RenderTieredPort } from "./doctor-command.js";
import { summaryLine } from "./doctor.js";
import { canonicalDir } from "./safe-fs.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { dirFormat, effectiveLayout, toolSurfaceFor } from "./blocks/naming.js";
import { runMigration, resumeRollback, plainMemoryWriteGate } from "./blocks/migrate.js";
import { memoryDirFor } from "./paths.js";
import { resolveJevWiring, type JevDomainKind } from "./jev/config.js";
import { wireJev } from "./jev/wire.js";
import { createJevWritePort } from "./jev/write-port.js";
import type { JevBashJobsLitePort, JevDoctorPort, JevFleetPort, JevRenderInfo, JevTodoPort } from "./jev/contracts.js";

export interface WireMemoryOpts {
  settings: MemorySettings;
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
  runDoctor?: typeof runDoctor;
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
  /** §7's spawn port for `/mem tidy`/`/mem restore`. Called at most once by
   *  `src/index.ts`, post-guard, main session only; `undefined` restores the
   *  "tidy unavailable in this session" fallback (child sessions never get
   *  this called at all). */
  attachTidy(port: TidyPort | undefined): void;
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
  const doctorRunner = opts.runDoctor ?? runDoctor;
  const budget: InjectBudget = {
    inlineMax: opts.settings.inlineMax,
    byteCap: opts.settings.byteCap,
    indexMax: opts.settings.indexMax,
  };
  let tidyPort: TidyPort | undefined;
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
  const triggerSweep = (cwd: string, reason: SweepReason, origin?: string): void => {
    if (
      !opts.settings.governance.enabled ||
      opts.isChildSession ||
      opts.secureDomainKind === "locked" ||
      origin === "sweep"
    )
      return;
    const dir = memoryDirFor(cwd);
    if (!gate.check(dir).ok || dirFormat(dir) !== "blocks") return;
    let runner = sweepRunners.get(dir);
    if (!runner) {
      runner = createSweepRunner({
        enabled: true,
        gate,
        residentBudget: opts.settings.residentBytes,
        notify: (message) => governanceNotify?.(message),
        onAfterWrite: () => onAfterWrite(cwd, "sweep"),
      });
      sweepRunners.set(dir, runner);
    }
    void runner.runSweep(dir, reason, migrationAbort.signal, origin);
  };
  const onAfterWrite = (cwd: string, origin?: string): void => {
    if (origin !== "sweep") triggerSweep(cwd, "write", origin);
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
    } else if (opts.settings.layout === "tiered") {
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
    migrationAbort.abort();
    migrationAbort = new AbortController();
    sweepRunners.clear();
    governanceNotify = ctx.hasUI ? (message) => ctx.ui.notify(message, "warning") : undefined;
    // Non-blocks/child/locked paths remain byte-identical and do not probe disk.
    if (opts.isChildSession || opts.settings.layout !== "blocks" || opts.secureDomainKind === "locked") return;
    const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
    const dir = memoryDirFor(cwd);
    if (!gate.check(dir).ok || !canonicalDir(dir)) return;
    try {
      await resumeRollback(dir, { gate, signal: migrationAbort.signal });
      triggerSweep(cwd, "startup");
      if (!opts.settings.migrate.auto || dirFormat(dir) !== "files") return;
      const result = await runMigration(dir, {
        gate,
        signal: migrationAbort.signal,
        diag: (message) => {
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
        },
      });
      if (result.outcome === "committed") {
        onAfterWrite(cwd, "migrate");
        if (ctx.hasUI)
          ctx.ui.notify(
            `memory: migrated ${result.plan!.report.files.length} files → ${result.plan!.blocks.length} blocks — /mem migrate --report · undo: /mem migrate --rollback`,
            "info",
          );
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
    onRender: (cwd, block, info, resident) => {
      lastBlocks.set(cwd, block);
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
  const surface = toolSurfaceFor(
    opts.settings,
    dirFormat(memoryDirFor(resolveWorktreeOrigin(process.cwd()) ?? process.cwd())),
    opts.secureDomainKind === "locked",
  );
  const toolCommon = {
    settings: opts.settings,
    isChildSession: opts.isChildSession,
    onAfterWrite,
    ...(opts.scopes ? { writeGate: gate } : {}),
    ...(opts.sessionSignal === undefined ? {} : { sessionSignal: opts.sessionSignal }),
  };
  pi.registerTool(
    surface === "v3"
      ? createMemoryToolV3({
          ...toolCommon,
          writeGate: gate,
          doctorSummary,
          ...(jev === undefined ? {} : { jev: jev.makeWritePort() }),
        })
      : surface === "v2"
        ? createMemoryToolV2({
            ...toolCommon,
            ...(opts.settings.layout === "tiered" ? { renderBlock: tieredRender } : {}),
            doctorSummary,
            ...(jev === undefined ? {} : { jev: jev.makeWritePort() }),
          })
        : createMemoryTool({
            settings: opts.settings,
            isChildSession: opts.isChildSession,
            onAfterWrite,
            ...(opts.scopes ? { writeGate: gate } : {}),
          }),
  );
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
      getTidyPort: () => tidyPort,
      writeGate: gate,
      settings: opts.settings,
      renderBlock: tieredRender,
      runDoctor: doctorRunner,
      onAfterWrite,
      ...(jev === undefined ? {} : { jev: jev.commandPort }),
    }),
  );
  return {
    webRead: executeMemoryRead,
    attachTidy(port) {
      tidyPort = port;
    },
    renderForExternal(cwd: string): string | undefined {
      return renderExternalMemoryBlock({ settings: opts.settings, cache }, cwd);
    },
    attachJevPredictPorts(ports) {
      jev?.attachPredictPorts(ports);
    },
  };
}
