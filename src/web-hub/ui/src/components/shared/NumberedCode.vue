<!--
  NumberedCode.vue — the syntax-highlighted, line-numbered preview body (preview
  line-numbers package, 2026-10-23): `HighlightedCode`'s numbered twin for the preview's
  non-stream source view. Same engine pipeline (shared `highlight-core.ts`: lazy Prism
  chunk, plain-first render, 150 ms settle debounce, large-text/token-budget degradation),
  then the flat token parts are split per logical line (`@logic/previewLines.ts`'s
  `splitPartsIntoCodeLines` — cross-line tokens are CUT, class carried to both pieces) and
  rendered by `CodeLines.vue`.

  Degradation parity with `HighlightedCode`: unknown language / engine-load failure /
  over-`shouldHighlight`-gate text ⇒ plain-text LINES (the line numbers are independent of
  highlighting and stay). Rendered `textContent` is byte-identical to the legacy
  `<pre><HighlightedCode>` body (each line carries its own "\n" — see previewLines.ts).
-->
<script setup lang="ts">
import { computed } from "vue";
import { splitPartsIntoCodeLines, splitTextIntoCodeLines, type CodeLine } from "@logic/previewLines.js";
import CodeLines from "./CodeLines.vue";
import { useHighlightParts } from "./highlight-core.js";

const props = defineProps<{
  readonly text: string;
  /** Prism grammar id (`@logic/highlight.js`'s resolvers); null/absent ⇒ plain lines. */
  readonly lang?: string | null;
  /** preview-perf P3 §5.2: one-shot preview bodies pass `immediate` — with the engine
   * already resolved the FIRST render is highlighted (no plain→highlight swap). */
  readonly immediate?: boolean;
}>();

const parts = useHighlightParts(() => ({ text: props.text, lang: props.lang ?? null }), {
  immediate: props.immediate === true,
});

const lines = computed<readonly CodeLine[]>(() =>
  parts.value === null ? splitTextIntoCodeLines(props.text) : splitPartsIntoCodeLines(parts.value),
);
</script>

<template>
  <CodeLines :lines="lines" />
</template>
