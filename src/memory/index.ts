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
import type { AskUserRemotePort } from "../ask-user/remote.js";
import type { MemorySettings } from "../config/settings.js";
import type { PromptSectionHub } from "../sysprompt/hub.js";
import type { TidyPort } from "./contracts.js";
import { createMemCommand } from "./command.js";
import { memorySection, renderExternalMemoryBlock } from "./inject.js";
import { RenderCache, type InjectBudget } from "./render.js";
import { createMemoryTool } from "./tool.js";
import { createMemoryToolV2 } from "./tool-v2.js";
import { renderTiered } from "./tiered.js";
import { runDoctor } from "./doctor.js";
import { createStartupReminder, collectDoctorFindings, type RenderTieredPort } from "./doctor-command.js";
import { summaryLine } from "./doctor.js";
import { canonicalDir } from "./safe-fs.js";
import { memoryDirFor } from "./paths.js";
import { resolveJevWiring, type JevDomainKind } from "./jev/config.js";
import { wireJev } from "./jev/wire.js";
import { createJevWritePort } from "./jev/write-port.js";
import type { JevBashJobsLitePort, JevDoctorPort, JevFleetPort, JevRenderInfo, JevTodoPort } from "./jev/contracts.js";

export interface WireMemoryOpts {
  settings: MemorySettings;
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
  /** headless-confirm plan (docs/dev/memory/headless-confirm/plan.md): the
   *  late-bound ask_user remote port getter (`src/index.ts` passes
   *  `() => askUserRemoteRef.current?.()` — the hub wiring may land after
   *  wireMemory returned, so the getter MUST be evaluated at each guard
   *  invocation, never snapshotted). `undefined` ⇒ every guard confirm
   *  keeps the legacy local path byte-identical. */
  remote?: () => AskUserRemotePort | undefined;
  /** headless-confirm plan: the session lifecycle signal getter, owned by
   *  `src/index.ts` (fresh controller per session_start, aborted on
   *  session_shutdown/reload — merged into the MAIN session's existing hook
   *  registrations there, so wiring memory never adds a hook registration;
   *  child sessions hard-refuse guards before any confirm and never need
   *  it). Guards concatenate it with the tool signal per call. */
  sessionSignal?: () => AbortSignal | undefined;
  /** memory-predict plan §11.1 signal T — forwarded verbatim to `wireJev`'s
   *  `todo` dep (undefined ⇒ P1b sees an empty todo list). */
  todo?: () => JevTodoPort | undefined;
}

export interface WireMemoryResult {
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
  const onAfterWrite = (cwd: string): void => {
    if (opts.settings.freezeInjectionAfterWrite) {
      // The tiered cache has more dimensions than legacy's InjectBudget. The
      // last provider result is the exact block that was in the prompt, so it
      // is the correct freeze source for either layout (including an explicit
      // "no block" result before the first render).
      frozenBlocks.set(cwd, lastBlocks.has(cwd) ? lastBlocks.get(cwd) : cache.peek(cwd, budget)?.block);
    } else if (opts.settings.layout === "tiered") {
      lastBlocks.delete(cwd);
    } else {
      cache.delete(cwd);
    }
    for (const hook of afterWriteHooks) hook(cwd);
  };

  pi.on("session_start", () => {
    frozenBlocks.clear();
    lastBlocks.clear();
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
      if (event.reason === "reload") reminder.reset();
    });
  }
  opts.sections.register(
    "pi_project_memory",
    memorySection({
      settings: opts.settings,
      isChildSession: opts.isChildSession,
      cache,
      frozenBlocks,
      onRender: (cwd, block, info) => {
        lastBlocks.set(cwd, block);
        if (jevOn && info !== undefined) renderInfos.set(cwd, info);
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
    }),
  );
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
  pi.registerTool(
    opts.settings.toolSurface === "v2"
      ? createMemoryToolV2({
          settings: opts.settings,
          isChildSession: opts.isChildSession,
          onAfterWrite,
          ...(opts.settings.layout === "tiered" ? { renderBlock: tieredRender } : {}),
          doctorSummary,
          ...(jev === undefined ? {} : { jev: jev.makeWritePort() }),
          ...(opts.remote === undefined ? {} : { remote: opts.remote }),
          ...(opts.sessionSignal === undefined ? {} : { sessionSignal: opts.sessionSignal }),
        })
      : createMemoryTool({ settings: opts.settings, isChildSession: opts.isChildSession, onAfterWrite }),
  );
  pi.registerCommand(
    "mem",
    createMemCommand({
      isChildSession: opts.isChildSession,
      getTidyPort: () => tidyPort,
      settings: opts.settings,
      renderBlock: tieredRender,
      runDoctor: doctorRunner,
      onAfterWrite,
      ...(jev === undefined ? {} : { jev: jev.commandPort }),
    }),
  );
  return {
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
