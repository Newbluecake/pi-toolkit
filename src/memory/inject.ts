/**
 * `pi_project_memory` section registration (memory-plan §5.2, sysprompt-stable
 * plan §4.6): a `SectionRegistration` whose provider renders the `## Memory`
 * block for the current cwd. `wireMemory` (src/memory/index.ts) registers it
 * into the shared `PromptSectionHub`, which folds it into `event.systemPrompt`
 * — memory no longer owns its own `before_agent_start` hook (M3).
 *
 * Semantics carried over unchanged from the pre-M3 `createMemoryInjectHook`:
 * - settings are a STATIC object captured at activate() (Nit 7) — the
 *   `enabled` gate lives in the assembly layer, so there is deliberately no
 *   enabled check here;
 * - empty directory / no directory → `""` (Live: "no content this turn" —
 *   the hub treats this as a `removed` update if a block was previously
 *   announced, and as "nothing to fold" otherwise; sysprompt-stable §4.1);
 * - frozen blocks (freezeInjectionAfterWrite) are a block SOURCE, not an
 *   early return: frozen and fresh blocks both flow through the same
 *   double-injection guard (R2);
 * - double-injection guard (Nit 12): our own HTML-comment sentinel plus a
 *   compatibility check for the original plugin's `## Memory (<slug>)`
 *   banner (coexistence period, §6.2) — implemented as the registration's
 *   `skipIf`, checked against the ACCUMULATED prompt text at this point in
 *   the fold chain (today: the raw `event.systemPrompt`, since memory folds
 *   first; sysprompt-stable §4.2);
 * - cwd resolution keeps the three-level fallback (review-2 #12):
 *   `optionsCwd ?? ctx.cwd (may throw — assertActive) ?? process.cwd()`,
 *   then resolves worktree origin (B3);
 * - the provider NEVER throws: any failure degrades to `SKIP` (hub keeps the
 *   last-known snapshot, sysprompt-stable I5) — same "never crash" contract
 *   as before, expressed through the hub's error semantics instead of a
 *   local try/catch returning `undefined`.
 */

import { SKIP, type Live } from "../prompt-sections/stable-section.js";
import type { SectionProviderInput, SectionRegistration } from "../sysprompt/hub.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { toSlug, type MemoryPaths } from "./paths.js";
import {
  injectionSentinel,
  memoryFingerprint,
  renderMemoryBlock,
  type InjectBudget,
  type RenderCache,
} from "./render.js";

export interface MemorySectionDeps {
  settings: MemorySettings; // 静态（Nit 7）
  isChildSession: boolean;
  cache: RenderCache;
  frozenBlocks: Map<string, string | undefined>;
  paths?: MemoryPaths;
}

/** `ctx.cwd` is an `assertActive()`-guarded getter (pc87:runner.js:565-568);
 *  reading it outside an active run throws — fall back to `undefined` so the
 *  caller can continue down the three-level chain (review-2 #12). */
function tryCtxCwd(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.cwd;
  } catch {
    return undefined;
  }
}

/** `## Memory (<slug>)` is the stable prefix of the block's real first line
 *  (`## Memory (<slug>) — N file(s)`, render.ts:154) — used both as the
 *  double-injection guard needle and as the update-message title (§4.3). */
export function memoryTitle(slug: string): string {
  return `## Memory (${slug})`;
}

function resolveCwd(input: SectionProviderInput): string {
  const rawCwd = input.optionsCwd ?? tryCtxCwd(input.ctx) ?? process.cwd();
  // B3: worktree child sessions inject the MAIN repository's memory.
  return resolveWorktreeOrigin(rawCwd) ?? rawCwd;
}

function renderLive(deps: MemorySectionDeps, cwd: string): Live {
  const budget: InjectBudget = {
    inlineMax: deps.settings.inlineMax,
    byteCap: deps.settings.byteCap,
    indexMax: deps.settings.indexMax,
  };
  let block: string | undefined;
  if (deps.frozenBlocks.has(cwd)) {
    // Frozen source (§5.5): may be a captured `undefined` (R3), which flows
    // to the same "nothing to inject" exit below.
    block = deps.frozenBlocks.get(cwd);
  } else {
    const fingerprint = memoryFingerprint(cwd, deps.paths);
    const cached = deps.cache.get(cwd, budget, fingerprint);
    if (cached !== undefined) {
      block = cached.block;
    } else {
      block = renderMemoryBlock(cwd, budget, deps.paths);
      deps.cache.set(cwd, budget, fingerprint, block);
    }
  }
  return block ?? "";
}

/**
 * Build the `pi_project_memory` section registration. The provider is
 * synchronous (review-2 already confirmed `memoryFingerprint` /
 * `renderMemoryBlock` are sync) — required by the hub's provider contract
 * (I7: no async IO on the request path).
 */
export function memorySection(deps: MemorySectionDeps): SectionRegistration {
  return {
    provider: (input) => {
      if (deps.isChildSession && !deps.settings.injectInChildSessions) return "";
      try {
        const cwd = resolveCwd(input);
        return renderLive(deps, cwd);
      } catch {
        return SKIP; // never crash the session
      }
    },
    title: (input) => {
      try {
        return memoryTitle(toSlug(resolveCwd(input)));
      } catch {
        return memoryTitle("unknown");
      }
    },
    pointerHint: "Use the memory tool (action: 'list') to read the current entries.",
    skipIf: (input) => {
      try {
        const slug = toSlug(resolveCwd(input));
        return input.promptText.includes(injectionSentinel(slug)) || input.promptText.includes(memoryTitle(slug));
      } catch {
        return false;
      }
    },
  };
}
