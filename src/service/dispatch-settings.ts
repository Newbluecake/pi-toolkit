/**
 * service · agent dispatch settings (#56 batch 2 ⑧): the `agent` block (spawn admission, `queueWhenFull`) —
 * type, frozen defaults and never-throws parser. `src/config/settings.ts` imports ONLY this module for the block.
 */

/**
 * L1 (agent-tool pool-full plan §2): top-level/nested Agent tool dispatch
 * policy when the concurrency pool is already full. Default is `false`
 * (reject immediately, no queueing); `true` restores the pre-L1 queue-wait
 * behavior (subject to `budget.queueWaitS`'s own timeout). Workflow children
 * (src/workflow/) and every other spawn path (/task, resume) never
 * read this setting — they always queue, unaffected by this toggle.
 */
export interface AgentDispatchSettings {
  queueWhenFull: boolean;
}

/** Parse the optional `agent` settings block (L1). Field-by-field fallback to defaults, never throws. */
export function parseAgentDispatchSettings(input: unknown): AgentDispatchSettings {
  const defaults = DEFAULT_AGENT_DISPATCH_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const queueWhenFull = (input as Record<string, unknown>).queueWhenFull;
  return { queueWhenFull: typeof queueWhenFull === "boolean" ? queueWhenFull : defaults.queueWhenFull };
}

export const DEFAULT_AGENT_DISPATCH_SETTINGS: AgentDispatchSettings = { queueWhenFull: false };
