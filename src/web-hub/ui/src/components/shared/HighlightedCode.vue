<!--
  Shared syntax-highlighted code renderer (syntax-highlight package, 2026-10), used by
  PreviewText.vue (file preview, language from the basename) and CodeBlock.vue (markdown
  fence, language from the info string). Render-only: language resolution, thresholds and
  the token-tree flattening all live in the DOM-free `@logic/highlight.js`.

  Safety / behavior contract:
  - NEVER v-html/innerHTML: Prism's token tree is flattened by `flattenTokens` and rendered
    as Vue VNodes (text nodes + `<span class="tok-*">`), so arbitrary file content —
    including a literal `<script>` — renders as inert text (component-tested).
  - The Prism engine + language packs load through a dynamic `import()` (one code-split
    chunk, first screen never pays). Until it arrives — and forever if the import fails, the
    language is unknown, or `shouldHighlight` degrades a huge text — the output is the
    plain-text DOM the callers had before this package (a single text node).
  - Streaming (CodeBlock): the latest text renders PLAIN immediately on every change and is
    only re-tokenized after it settles for `HIGHLIGHT_DEBOUNCE_MS`, so a busy stream never
    tokenizes per frame.
-->
<script lang="ts">
import { defineComponent, h, onBeforeUnmount, ref, watch, type PropType, type VNodeChild } from "vue";
import { flattenTokens, HIGHLIGHT_DEBOUNCE_MS, shouldHighlight } from "@logic/highlight.js";

/** The structural surface this component uses (typed in `prism.d.ts`). */
interface PrismLike {
  readonly languages: Record<string, unknown>;
  tokenize(text: string, grammar: unknown): unknown[];
}

/** One shared in-flight load for every mounted instance; `null` = load failed ⇒ plain text. */
let prismPromise: Promise<PrismLike | null> | null = null;
function loadPrism(): Promise<PrismLike | null> {
  prismPromise ??= import("./highlight-impl.js").then((m) => m.default as PrismLike).catch(() => null);
  return prismPromise;
}

export default defineComponent({
  name: "HighlightedCode",
  props: {
    text: { type: String, required: true },
    /** Prism grammar id (from `@logic/highlight.js`'s resolvers); null/absent ⇒ plain text. */
    lang: { type: String as PropType<string | null>, default: null },
  },
  setup(props) {
    const prism = ref<PrismLike | null>(null);
    /** Non-null ⇒ highlighted parts; null ⇒ plain-text rendering (single text node). */
    const parts = ref<ReturnType<typeof flattenTokens>>(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    void loadPrism().then((p) => {
      if (!disposed) prism.value = p;
    });

    function recompute(): void {
      const p = prism.value;
      const lang = props.lang;
      if (p === null || lang === null || !shouldHighlight(props.text)) {
        parts.value = null;
        return;
      }
      const grammar = p.languages[lang];
      if (grammar === undefined) {
        parts.value = null;
        return;
      }
      try {
        parts.value = flattenTokens(p.tokenize(props.text, grammar));
      } catch {
        parts.value = null; // a grammar must never break rendering — fall back to plain text
      }
    }

    watch(
      () => [props.text, props.lang, prism.value] as const,
      () => {
        // Latest text shows plain right away (identical pre-highlight DOM); tokenizing is
        // debounced so a streaming CodeBlock never re-tokenizes per frame.
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

    return (): VNodeChild => {
      const f = parts.value;
      if (f === null) return props.text;
      return f.map((part) => (part.cls === "" ? part.text : h("span", { class: part.cls }, part.text)));
    };
  },
});
</script>
