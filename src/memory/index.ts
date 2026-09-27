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
import type { TidyPort } from "./contracts.js";
import { createMemCommand } from "./command.js";
import { memorySection } from "./inject.js";
import { RenderCache, type InjectBudget } from "./render.js";
import { createMemoryTool } from "./tool.js";
import { createMemoryToolV2 } from "./tool-v2.js";
import { renderTiered } from "./tiered.js";
import { runDoctor } from "./doctor.js";
import { createStartupReminder, collectDoctorFindings, type RenderTieredPort } from "./doctor-command.js";
import { summaryLine } from "./doctor.js";

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
}

export interface WireMemoryResult {
  /** §7's spawn port for `/mem tidy`/`/mem restore`. Called at most once by
   *  `src/index.ts`, post-guard, main session only; `undefined` restores the
   *  "tidy unavailable in this session" fallback (child sessions never get
   *  this called at all). */
  attachTidy(port: TidyPort | undefined): void;
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
  };

  pi.on("session_start", () => {
    frozenBlocks.clear();
    lastBlocks.clear();
  });
  if (!opts.isChildSession) {
    const reminder = createStartupReminder({
      settings: opts.settings,
      isChildSession: false,
      renderTieredPort: tieredRender,
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
      onRender: (cwd, block) => lastBlocks.set(cwd, block),
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
  const doctorSummary = (cwd: string): string =>
    summaryLine(collectDoctorFindings(cwd, undefined, opts.settings, tieredRender));
  pi.registerTool(
    opts.settings.toolSurface === "v2"
      ? createMemoryToolV2({
          settings: opts.settings,
          isChildSession: opts.isChildSession,
          onAfterWrite,
          ...(opts.settings.layout === "tiered" ? { renderBlock: tieredRender } : {}),
          doctorSummary,
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
    }),
  );
  return {
    attachTidy(port) {
      tidyPort = port;
    },
  };
}
