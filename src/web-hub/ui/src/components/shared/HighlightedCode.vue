<!--
  Shared syntax-highlighted code renderer (syntax-highlight package, 2026-10), used by
  PreviewText.vue (file preview, language from the basename — the UN-numbered fallback body;
  the numbered one is `NumberedCode.vue`) and CodeBlock.vue (markdown fence, language from
  the info string). Render-only: language resolution, thresholds and the token-tree
  flattening all live in the DOM-free `@logic/highlight.js`; the engine load + debounce +
  tokenize pipeline is shared with `NumberedCode.vue` through `highlight-core.ts`
  (2026-10-23 extraction, behavior unchanged; J1 moved the tokenize itself into the shared
  highlight WORKER with a §5.1 main-thread fallback).

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
  - J1 #2 (jank-20kb LT-3): once parts arrive the spans apply in PART BLOCKS (≤512 parts per
    batch, one macrotask each); the not-yet-applied tail renders as one plain text node, so
    `textContent` is byte-identical at every stage (selection/copy/Ctrl+A unaffected — a
    non-collapsed selection inside the block DEFERS the remaining batches).
-->
<script lang="ts">
import {
  defineComponent,
  getCurrentInstance,
  h,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
  type VNodeChild,
} from "vue";
import {
  HIGHLIGHT_BATCH_MAX_PARTS,
  startHighlightBatches,
  useHighlightParts,
  type FlatPart,
  type HighlightBatchHandle,
} from "./highlight-core.js";

export default defineComponent({
  name: "HighlightedCode",
  props: {
    text: { type: String, required: true },
    /** Prism grammar id (from `@logic/highlight.js`'s resolvers); null/absent ⇒ plain text. */
    lang: { type: String as PropType<string | null>, default: null },
    /** preview-perf P3 §5.2: one-shot preview bodies pass `immediate` — with the engine
     *  already resolved the FIRST render is highlighted (no plain→highlight swap). The
     *  transcript's CodeBlock does not pass it (150 ms debounce unchanged). */
    immediate: { type: Boolean, default: false },
  },
  setup(props) {
    const parts = useHighlightParts(() => ({ text: props.text, lang: props.lang }), {
      immediate: props.immediate === true,
    });
    /** J1 #2: parts applied so far (`Infinity` ⇒ all — the §5.2 immediate sync swap skips
     *  staging exactly like NumberedCode; seeded from `parts` for the same setup reason). */
    const applied = ref<number>(parts.value === null ? 0 : Number.POSITIVE_INFINITY);
    let batch: HighlightBatchHandle | null = null;
    const instance = getCurrentInstance();
    /** The rewritten subtree's root for the selection-deferral check — the fragment's first
     *  node's parent (`<pre>`/`<code>` host); null before mount (nothing to defer on). */
    const rootEl = (): HTMLElement | null => {
      const el: unknown = instance?.proxy?.$el;
      if (el instanceof HTMLElement) return el;
      return el instanceof Text ? el.parentElement : null;
    };

    /** J1 #2 staging arm: a NEW parts value (worker reply / fallback tokenize) starts a batch
     *  run over its parts; `null` (text changed / degraded) drops any run and re-plains. */
    watch(parts, (p) => {
      batch?.cancel();
      batch = null;
      if (p === null) {
        applied.value = 0;
        return;
      }
      if (props.immediate === true) {
        applied.value = Number.POSITIVE_INFINITY; // §5.2/PB §7.3: small-file sync swap, no staging
        return;
      }
      applied.value = 0;
      batch = startHighlightBatches({
        total: p.length,
        next: (from) => Math.min(from + HIGHLIGHT_BATCH_MAX_PARTS, p.length),
        root: rootEl,
        apply: (_from, to) => {
          applied.value = to;
        },
      });
    });

    onBeforeUnmount(() => {
      batch?.cancel();
      batch = null;
    });

    return (): VNodeChild => {
      const f = parts.value;
      if (f === null) return props.text;
      const n = Math.min(applied.value, f.length);
      const out: VNodeChild[] = [];
      for (let i = 0; i < n; i++) {
        const part = f[i] as FlatPart;
        out.push(part.cls === "" ? part.text : h("span", { class: part.cls }, part.text));
      }
      if (n < f.length) {
        let tail = "";
        for (let i = n; i < f.length; i++) tail += (f[i] as FlatPart).text;
        out.push(tail); // the not-yet-applied tail: plain text, byte-identical content
      }
      return out;
    };
  },
});
</script>
