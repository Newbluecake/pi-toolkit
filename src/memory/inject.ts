/**
 * `before_agent_start` injection hook (memory-plan §5.2): appends the
 * rendered `## Memory` block for the current cwd to the system prompt.
 *
 * Semantics pinned by the plan:
 * - settings are a STATIC object captured at activate() (Nit 7) — the
 *   `enabled` gate lives in the assembly layer, so there is deliberately
 *   no enabled check here;
 * - empty directory / no directory → `undefined` (nothing injected);
 * - frozen blocks (freezeInjectionAfterWrite) are a block SOURCE, not an
 *   early return: frozen and fresh blocks both flow through the same
 *   double-injection guard (R2);
 * - double-injection guard (Nit 12): our own HTML-comment sentinel plus a
 *   compatibility check for the original plugin's `## Memory (<slug>)`
 *   banner (coexistence period, §6.2);
 * - NEVER throws: any failure degrades to `undefined` (no injection).
 */

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

export interface MemoryInjectDeps {
  settings: MemorySettings; // 静态（Nit 7）
  isChildSession: boolean;
  cache: RenderCache;
  frozenBlocks: Map<string, string | undefined>;
  paths?: MemoryPaths;
}

export type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined>;

export function createMemoryInjectHook(deps: MemoryInjectDeps): BeforeAgentStartHandler {
  const { settings } = deps;
  const budget: InjectBudget = {
    inlineMax: settings.inlineMax,
    byteCap: settings.byteCap,
    indexMax: settings.indexMax,
  };
  return async (event, ctx) => {
    try {
      if (deps.isChildSession && !settings.injectInChildSessions) return undefined;
      const rawCwd = event?.systemPromptOptions?.cwd ?? ctx?.cwd ?? process.cwd();
      // B3: worktree child sessions inject the MAIN repository's memory.
      const cwd = resolveWorktreeOrigin(rawCwd) ?? rawCwd;

      let block: string | undefined;
      if (deps.frozenBlocks.has(cwd)) {
        // Frozen source (§5.5): may be a captured `undefined` (R3), which
        // flows to the same "nothing to inject" exit below.
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
      if (block === undefined) return undefined;

      const slug = toSlug(cwd);
      const prompt = event.systemPrompt;
      if (prompt.includes(injectionSentinel(slug)) || prompt.includes(`## Memory (${slug})`)) return undefined;
      return { systemPrompt: prompt + "\n\n" + block };
    } catch {
      return undefined; // never crash the session
    }
  };
}
