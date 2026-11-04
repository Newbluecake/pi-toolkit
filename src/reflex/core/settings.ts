/**
 * jev-reflex · settings (arch §4.1). `src/config/settings.ts` imports ONLY this module for the `reflex`
 * block: interface + frozen defaults + never-throws parser (parseTopicSwitchSettings 同款).
 * Code constants (budget, windows, caps) deliberately live in `core/budget.ts` (R1), not here.
 */

export interface ReflexSettings {
  /** Non-live; false ⇒ `wireReflex` is never called (I9). secure/locked domains force false (D8). */
  enabled: boolean;
  /** Live; script ids allowed to autoresolve. Empty ⇒ everything runs shadow only. Unknown ids are ignored. */
  autoResolve: readonly string[];
}

export const DEFAULT_REFLEX_SETTINGS: Readonly<ReflexSettings> = Object.freeze({
  enabled: false,
  autoResolve: Object.freeze([] as string[]),
});

/** csv string or string[] → trimmed, empty-dropped, order-preserving deduped list. */
function parseIdList(raw: unknown): string[] {
  const parts =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const id = part.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Parse the optional `reflex` block: field-by-field fallback to defaults, never throws. */
export function parseReflexSettings(input: unknown): ReflexSettings {
  const d = DEFAULT_REFLEX_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { enabled: d.enabled, autoResolve: [] };
  const v = input as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    // Fresh array on every parse (the frozen default is never handed out as a mutable alias).
    autoResolve: v.autoResolve === undefined ? [] : parseIdList(v.autoResolve),
  };
}
