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
export function loadPrism(): Promise<PrismLike | null> {
  prismPromise ??= import("./highlight-impl.js").then((m) => m.default as PrismLike).catch(() => null);
  return prismPromise;
}

/**
 * The reactive highlight pipeline. `source` is re-read on every invalidation (props or the
 * late-arriving engine). Returns a ref that is `null` while/forever-plain, or the flattened
 * token parts once tokenized. Must be called during setup (owns a watcher + unmount hook).
 */
export function useHighlightParts(
  source: () => { readonly text: string; readonly lang: string | null },
): Ref<FlatPart[] | null> {
  const prism = ref<PrismLike | null>(null);
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
