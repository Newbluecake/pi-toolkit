<!--
  Shared syntax-highlighted code renderer (syntax-highlight package, 2026-10), used by
  PreviewText.vue (file preview, language from the basename — the UN-numbered fallback body;
  the numbered one is `NumberedCode.vue`) and CodeBlock.vue (markdown fence, language from
  the info string). Render-only: language resolution, thresholds and the token-tree
  flattening all live in the DOM-free `@logic/highlight.js`; the engine load + debounce +
  tokenize pipeline is shared with `NumberedCode.vue` through `highlight-core.ts`
  (2026-10-23 extraction, behavior unchanged).

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
import { defineComponent, h, type PropType, type VNodeChild } from "vue";
import { useHighlightParts } from "./highlight-core.js";

export default defineComponent({
  name: "HighlightedCode",
  props: {
    text: { type: String, required: true },
    /** Prism grammar id (from `@logic/highlight.js`'s resolvers); null/absent ⇒ plain text. */
    lang: { type: String as PropType<string | null>, default: null },
    /** preview-perf P3 §5.2: one-shot preview bodies pass `immediate` — with the engine
     * already resolved the FIRST render is highlighted (no plain→highlight swap). The
     * transcript's CodeBlock does not pass it (150 ms debounce unchanged). */
    immediate: { type: Boolean, default: false },
  },
  setup(props) {
    const parts = useHighlightParts(() => ({ text: props.text, lang: props.lang }), {
      immediate: props.immediate === true,
    });
    return (): VNodeChild => {
      const f = parts.value;
      if (f === null) return props.text;
      return f.map((part) => (part.cls === "" ? part.text : h("span", { class: part.cls }, part.text)));
    };
  },
});
</script>
