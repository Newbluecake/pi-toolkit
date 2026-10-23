/**
 * Shared syntax-highlight driver (extracted from `HighlightedCode.vue`, 2026-10-23, for the
 * preview line-numbers package): the lazily-imported Prism engine handle plus the
 * load → debounce → tokenize → flatten reactive pipeline. Both `HighlightedCode.vue`
 * (transcript fences + the legacy un-numbered preview body) and `NumberedCode.vue` (the
 * numbered per-line preview body) ride this — the behavior contract is unchanged:
 *
 *  - the Prism engine + language packs load through ONE shared dynamic `import()` (one
 *    code-split chunk, first screen never pays; a failed load ⇒ plain text forever);
 *  - every text/lang change renders PLAIN immediately and only re-tokenizes after the text
 *    settles for `HIGHLIGHT_DEBOUNCE_MS` (a busy stream never tokenizes per frame);
 *  - `shouldHighlight`'s large-text gates and a token-budget/grammar failure all degrade to
 *    `null` parts ⇒ the caller renders its plain-text DOM.
 *
 * Rendering stays with the callers (VNode `<span class="tok-*">` — never v-html/innerHTML).
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { flattenTokens, HIGHLIGHT_DEBOUNCE_MS, shouldHighlight } from "@logic/highlight.js";

/** The structural surface the engine implements (typed in `prism.d.ts`). */
export interface PrismLike {
  readonly languages: Record<string, unknown>;
  tokenize(text: string, grammar: unknown): unknown[];
}

/** One flattened render fragment (`flattenTokens`'s row shape). */
export interface FlatPart {
  readonly cls: string;
  readonly text: string;
}

/** One shared in-flight load for every mounted instance; `null` = load failed ⇒ plain text. */
let prismPromise: Promise<PrismLike | null> | null = null;

/**
 * preview-perf P3 §5.2: the SYNCHRONOUS engine cache. `undefined` = the load has not settled
 * yet; once it has, this is exactly the promise's resolution — a later `useHighlightParts`
 * call starts with the engine already in hand and can tokenize during setup, so the FIRST
 * render of a one-shot preview body is the highlighted VNode instead of a plain text node
 * that gets replaced a moment later (评审 r1 #11: `debounceMs = 0` alone cannot do that —
 * the 150 ms debounce would still emit plain first). Written inside `loadPrism()`'s settled
 * handlers; never read before the first call.
 */
let resolvedPrism: PrismLike | null | undefined = undefined;

export function loadPrism(): Promise<PrismLike | null> {
  prismPromise ??= import("./highlight-impl.js")
    .then((m) => {
      resolvedPrism = m.default as PrismLike;
      return resolvedPrism;
    })
    .catch(() => {
      resolvedPrism = null; // failed load ⇒ plain text forever (contract unchanged)
      return null;
    });
  return prismPromise;
}

/**
 * The reactive highlight pipeline. `source` is re-read on every invalidation (props or the
 * late-arriving engine). Returns a ref that is `null` while/forever-plain, or the flattened
 * token parts once tokenized. Must be called during setup (owns a watcher + unmount hook).
 *
 * preview-perf P3 §5.2 — `opts.immediate` (the one-shot preview bodies pass it; the
 * transcript's CodeBlock does NOT, keeping its 150 ms debounce byte-identical): when the
 * engine is already resolved (`resolvedPrism` — the synchronous cache above), parts are
 * computed SYNCHRONOUSLY in setup, so the caller's first render is already highlighted; a
 * cold engine still renders plain first and swaps exactly once on arrival; a failed load
 * stays plain forever. Subsequent text/lang changes in immediate mode also re-tokenize
 * synchronously (one-shot callers change text at most on a retry remount).
 */
export function useHighlightParts(
  source: () => { readonly text: string; readonly lang: string | null },
  opts?: { readonly immediate?: boolean },
): Ref<FlatPart[] | null> {
  const immediate = opts?.immediate === true;
  const prism = ref<PrismLike | null>(resolvedPrism ?? null);
  /** Non-null ⇒ highlighted parts; null ⇒ plain-text rendering. */
  const parts = ref<FlatPart[] | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  void loadPrism().then((p) => {
    if (!disposed) prism.value = p;
  });

  function recompute(): void {
    const p = prism.value;
    const { text, lang } = source();
    if (p === null || lang === null || !shouldHighlight(text)) {
      parts.value = null;
      return;
    }
    const grammar = p.languages[lang];
    if (grammar === undefined) {
      parts.value = null;
      return;
    }
    try {
      parts.value = flattenTokens(p.tokenize(text, grammar)) as FlatPart[] | null;
    } catch {
      parts.value = null; // a grammar must never break rendering — fall back to plain text
    }
  }

  watch(
    () => [source().text, source().lang, prism.value] as const,
    () => {
      if (immediate && prism.value !== null) {
        // Engine in hand (setup-time via the sync cache, or a later arrival): tokenize NOW —
        // the first render is the highlighted VNode (§5.2), never plain-then-replace.
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        recompute();
        return;
      }
      // Latest text shows plain right away (identical pre-highlight DOM); tokenizing is
      // debounced so a streaming caller never re-tokenizes per frame.
      parts.value = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(recompute, HIGHLIGHT_DEBOUNCE_MS);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
  });

  return parts;
}
