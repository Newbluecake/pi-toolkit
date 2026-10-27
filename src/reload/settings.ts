/**
 * reload · settings (#56 batch 2 ⑧): the deferred-`/reload` block's type, frozen defaults and never-throws parser.
 * `src/config/settings.ts` imports ONLY this module for the block.
 */

/**
 * Deferred /reload (src/reload/): intercept exact `/reload` submissions while
 * subagents are still running and fire the real reload once the fleet settles.
 * Field-by-field tolerant parsing (parseReloadSettings), never throws.
 */
export interface ReloadSettings {
  /** Gate for the editor interception only; `/agent reload` works regardless. Default true. */
  defer: boolean;
}

/** Parse the optional deferred-reload settings block (parseCacheTtlSettings 同款容错, never throws). */
export function parseReloadSettings(input: unknown): ReloadSettings {
  const defaults = DEFAULT_RELOAD_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const defer = (input as Record<string, unknown>).defer;
  return { defer: typeof defer === "boolean" ? defer : defaults.defer };
}

export const DEFAULT_RELOAD_SETTINGS: ReloadSettings = { defer: true };
