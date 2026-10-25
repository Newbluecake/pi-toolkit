/**
 * preview-perf P3 (plan r3 §4.6) — the SINGLETON CSS Custom Highlight manager for the
 * in-window find. `CSS.highlights` is a DOCUMENT-level registry: without one coordinator,
 * two preview windows finding at the same time would overwrite each other's `pv-find`
 * Highlight. This module is that coordinator:
 *
 *  - `acquireFindHighlights(ownerId)` registers one owner (a preview window) and returns a
 *    `{ setRanges, release }` handle, or `null` when the engine cannot support it
 *    (`CSS.highlights` or the `Highlight` constructor missing — K9 old engines) — the
 *    caller then falls back to marking the current hit with the native selection (§4.6);
 *  - every `setRanges`/`release` recomputes the UNION of all live owners' ranges and
 *    re-registers exactly two Highlights — `pv-find` (all hits) and `pv-find-cur` (the
 *    current hit) — so closing one of two finding windows only removes ITS ranges;
 *  - the `::highlight(pv-find)` styling is injected ONCE through `insertRule` into an
 *    existing same-document stylesheet: `<style>` blocks are banned outright (source-scan)
 *    and a JS-created inline `<style>` element would be refused by the hub's
 *    `style-src 'self'` CSP, while `insertRule` on an already-authorized sheet is pure
 *    CSSOM and passes both. Engines that cannot parse `::highlight(...)` throw inside the
 *    guarded try — degradation is "no paint", never a crash.
 *
 * Module-scope state is deliberate (same pattern as `useLineNumbersPref`): one registry per
 * document, shared by every preview window instance. No Vue reactivity — callers drive it
 * imperatively after their own reactive decisions.
 */

/** The one handle shape an owner (a preview window's find bar) interacts with. */
export interface FindHighlightHandle {
  /** Replace this owner's ranges: `all` = every currently-markable hit, `cur` = the current hit (null = none). */
  setRanges(all: readonly Range[], cur: Range | null): void;
  /** Remove this owner for good (window closed / component unmount) — other owners survive. */
  release(): void;
}

/** Registry names (§4.6): `pv-find` = all hits, `pv-find-cur` = the current hit. */
const HL_ALL = "pv-find";
const HL_CUR = "pv-find-cur";

interface OwnerState {
  all: readonly Range[];
  cur: Range | null;
}

const owners = new Map<string, OwnerState>();
let styleRulesInstalled = false;

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = Map<string, unknown>;

/** The document's `CSS.highlights` registry, or null when the engine has none (K9). */
function registry(): HighlightRegistry | null {
  try {
    const css = (globalThis as { CSS?: { highlights?: unknown } }).CSS;
    const hl = css?.highlights;
    if (hl instanceof Map) return hl as HighlightRegistry;
  } catch {
    /* no CSS global — unsupported */
  }
  return null;
}

function highlightCtor(): HighlightCtor | null {
  const C = (globalThis as { Highlight?: unknown }).Highlight;
  return typeof C === "function" ? (C as HighlightCtor) : null;
}

/** The two `::highlight` paint rules, inserted once into an existing same-origin sheet. */
function installStyleRules(): void {
  if (styleRulesInstalled) return;
  styleRulesInstalled = true;
  try {
    const sheets = typeof document !== "undefined" ? document.styleSheets : null;
    const sheet: CSSStyleSheet | undefined = sheets === null ? undefined : (sheets.item(0) ?? undefined);
    if (sheet === undefined) return;
    // Colors ride the existing tokens with hard fallbacks; `::highlight` accepts normal
    // declarations. Engines without the pseudo throw here — guarded, paint-only degradation.
    sheet.insertRule(
      `::highlight(${HL_ALL}) { background-color: color-mix(in srgb, var(--c-accent, #7046d8) 28%, transparent); }`,
      sheet.cssRules.length,
    );
    sheet.insertRule(
      `::highlight(${HL_CUR}) { background-color: color-mix(in srgb, var(--c-focus, #1f8f84) 45%, transparent); }`,
      sheet.cssRules.length,
    );
  } catch {
    /* unpaintable engine — the API still works, nothing to clean up */
  }
}

/** Recompute the unions and re-register both Highlights (the only write path). */
function refresh(): void {
  const reg = registry();
  const Ctor = highlightCtor();
  if (reg === null || Ctor === null) return;
  const allRanges: Range[] = [];
  const curRanges: Range[] = [];
  for (const st of owners.values()) {
    allRanges.push(...st.all);
    if (st.cur !== null) curRanges.push(st.cur);
  }
  if (allRanges.length > 0) reg.set(HL_ALL, new Ctor(...allRanges));
  else reg.delete(HL_ALL);
  if (curRanges.length > 0) reg.set(HL_CUR, new Ctor(...curRanges));
  else reg.delete(HL_CUR);
}

/**
 * Register a find-range owner. Returns `null` on engines without the Custom Highlight API —
 * callers must then use the native-selection fallback for the current hit (§4.6, K9).
 */
export function acquireFindHighlights(ownerId: string): FindHighlightHandle | null {
  if (registry() === null || highlightCtor() === null) return null;
  owners.set(ownerId, { all: [], cur: null });
  installStyleRules();
  refresh();
  return {
    setRanges(all: readonly Range[], cur: Range | null): void {
      const st = owners.get(ownerId);
      if (st === undefined) return;
      st.all = [...all];
      st.cur = cur;
      refresh();
    },
    release(): void {
      owners.delete(ownerId);
      refresh();
    },
  };
}

/** Test hook: drop every owner and the installed-rules latch (fresh module state per test). */
export function resetFindHighlightsForTests(): void {
  owners.clear();
  styleRulesInstalled = false;
  const reg = registry();
  if (reg !== null) {
    reg.delete(HL_ALL);
    reg.delete(HL_CUR);
  }
}
