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
 * All mutable state (the RenderCache and the freezeInjectionAfterWrite
 * frozenBlocks map) lives in THIS closure (§5.2/§5.5: no module-scope
 * mutable state). Frozen blocks are per-session: cleared on session_start
 * (`/new` thaws; `/reload` re-activates with a fresh closure anyway), while
 * the fingerprint-keyed RenderCache survives across sessions. No timers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import type { PromptSectionHub } from "../sysprompt/hub.js";
import { createMemCommand } from "./command.js";
import { memorySection } from "./inject.js";
import { RenderCache, type InjectBudget } from "./render.js";
import { createMemoryTool } from "./tool.js";

export interface WireMemoryOpts {
  settings: MemorySettings;
  isChildSession: boolean;
  /** The shared PromptSectionHub (sysprompt-stable §4.6) that folds this
   *  section into the system prompt; created by src/index.ts before memory
   *  is wired so registration order == fold order (memory first). */
  sections: PromptSectionHub;
}

export function wireMemory(pi: ExtensionAPI, opts: WireMemoryOpts): void {
  const cache = new RenderCache();
  const frozenBlocks = new Map<string, string | undefined>();
  const budget: InjectBudget = {
    inlineMax: opts.settings.inlineMax,
    byteCap: opts.settings.byteCap,
    indexMax: opts.settings.indexMax,
  };
  // §5.5: freeze=false → invalidate so the next turn re-renders (one cache
  // miss); freeze=true → capture the pre-write block (peek miss ⇒ freeze to
  // "no block", R3) so the injected bytes stay stable for this session and
  // the write takes effect next session.
  const onAfterWrite = (cwd: string): void => {
    if (opts.settings.freezeInjectionAfterWrite) {
      frozenBlocks.set(cwd, cache.peek(cwd, budget)?.block);
    } else {
      cache.delete(cwd);
    }
  };

  pi.on("session_start", () => {
    frozenBlocks.clear();
  });
  opts.sections.register(
    "pi_project_memory",
    memorySection({
      settings: opts.settings,
      isChildSession: opts.isChildSession,
      cache,
      frozenBlocks,
    }),
  );
  pi.registerTool(
    createMemoryTool({
      settings: opts.settings,
      isChildSession: opts.isChildSession,
      onAfterWrite,
    }),
  );
  pi.registerCommand("mem", createMemCommand({}));
}
