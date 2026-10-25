<!--
  NumberedCode.vue — the syntax-highlighted, line-numbered preview body (preview
  line-numbers package, 2026-10-23): `HighlightedCode`'s numbered twin for the preview's
  non-stream source view. Same engine pipeline (shared `highlight-core.ts`: lazy Prism
  chunk, plain-first render, 150 ms settle debounce, large-text/token-budget degradation),
  then the flat token parts are split per logical line (`@logic/previewLines.ts`'s
  `splitPartsIntoCodeLines` — cross-line tokens are CUT, class carried to both pieces) and
  rendered by `CodeLines.vue`.

  J1 #2 (jank-20kb LT-3): once parts arrive (worker reply or fallback), the highlight is
  applied in PART BLOCKS (≤512 parts per batch, one macrotask per batch — never a single
  whole-body re-cloak); the cursor walks the FLAT parts array, so a file whose whole body
  is ONE huge line (minified JSON/JS) stages exactly like a many-line file. Rows past the
  cursor keep rendering as their plain split. textContent is byte-identical at every stage
  (same text, classed or not), so selection/copy/Ctrl+A semantics are untouched, and a
  non-collapsed selection inside the body DEFERS the remaining batches instead of
  collapsing under a row rewrite.

  Degradation parity with `HighlightedCode`: unknown language / engine-load failure /
  over-`shouldHighlight`-gate text ⇒ plain-text LINES (the line numbers are independent of
  highlighting and stay). Rendered `textContent` is byte-identical to the legacy
  `<pre><HighlightedCode>` body (each line carries its own "\n" — see previewLines.ts).
-->
<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, ref, watch } from "vue";
import {
  splitPartsIntoCodeLines,
  splitTextIntoCodeLines,
  type CodeLine,
  type CodeLinePart,
} from "@logic/previewLines.js";
import CodeLines from "./CodeLines.vue";
import {
  HIGHLIGHT_BATCH_MAX_PARTS,
  startHighlightBatches,
  useHighlightParts,
  type HighlightBatchHandle,
} from "./highlight-core.js";

const props = defineProps<{
  readonly text: string;
  /** Prism grammar id (`@logic/highlight.js`'s resolvers); null/absent ⇒ plain lines. */
  readonly lang?: string | null;
  /** preview-perf P3 §5.2: one-shot preview bodies pass `immediate` — with the engine
   *  already resolved the FIRST render is highlighted (no plain→highlight swap). */
  readonly immediate?: boolean;
}>();

const parts = useHighlightParts(() => ({ text: props.text, lang: props.lang ?? null }), {
  immediate: props.immediate === true,
});

/** Plain per-line split — the parts-null view AND the not-yet-applied tail of a batch run. */
const plainLines = computed(() => markRaw(splitTextIntoCodeLines(props.text)));
/** Highlighted per-line split — the COMPLETE view, used once every batch has landed. */
const hlLines = computed<readonly CodeLine[] | null>(() => {
  const p = parts.value;
  return p === null ? null : (markRaw(splitPartsIntoCodeLines(p)) as readonly CodeLine[]);
});
/**
 * Parts applied so far (`Infinity` ⇒ all; `0` ⇒ all plain) — the cursor walks the FLAT parts
 * array (a one-line 9k-part body stages exactly like a 400-line one; a line-count cursor
 * would re-cloak such a file in a single giant batch). Seeded from `parts` at setup: a §5.2
 * immediate sync tokenize happened BEFORE this component's watchers exist, and its contract
 * is the highlighted FIRST RENDER — no staging (the `immediate` watch arm below keeps that
 * true for later sync swaps too).
 */
const appliedParts = ref<number>(parts.value === null ? 0 : Number.POSITIVE_INFINITY);

/** The staged per-line view: parts [0, n) highlighted + the remainder as ONE plain blob —
 *  `splitPartsIntoCodeLines` then cuts the blob at the newlines, so the staged textContent
 *  is byte-identical to the plain and complete views (and the line count always matches). */
function stagedLines(p: readonly CodeLinePart[], n: number): CodeLine[] {
  const head = p.slice(0, n);
  let tail = "";
  for (let i = n; i < p.length; i++) tail += p[i]!.text;
  if (tail !== "") head.push({ cls: "", text: tail });
  return markRaw(splitPartsIntoCodeLines(head));
}

/** J1 #2 cursor: advance ~512 parts, then EXTEND to the end of that line — a batch boundary
 *  never splits a logical line, so every `.pv-line` block is dirtied by exactly ONE batch
 *  (a mid-line cursor re-lays-out the whole huge block per batch — measured quadratic:
 *  oneline.json Σ1.7 s @4× before this rule). A file that IS one huge line degenerates to a
 *  single batch — the pre-J1 whole swap (documented residual, see J1-report). */
function nextCursor(from: number): number {
  const p = parts.value;
  if (p === null) return from + 1;
  const n = p.length;
  let to = from + 1; // ≥1 part per batch — progress even on a pathological single part
  let cost = p[from]!.text.length;
  while (to < n && cost < HIGHLIGHT_BATCH_MAX_PARTS) {
    cost += p[to]!.text.length;
    to += 1;
  }
  while (to < n && !p[to - 1]!.text.endsWith("\n")) {
    cost += p[to]!.text.length;
    to += 1;
  }
  return to;
}

const lines = computed<readonly CodeLine[]>(() => {
  const hl = hlLines.value;
  if (hl === null) return plainLines.value;
  const applied = appliedParts.value;
  const p = parts.value;
  if (!(applied < p!.length)) return hl; // complete (also the `applied <= 0` case degenerates below)
  if (applied <= 0) return plainLines.value;
  return stagedLines(p!, Math.floor(applied));
});

let batch: HighlightBatchHandle | null = null;
const codeEl = ref<InstanceType<typeof CodeLines> | null>(null);

watch(parts, (p) => {
  batch?.cancel();
  batch = null;
  if (p === null) {
    appliedParts.value = 0; // plain again (text changed / degraded)
    return;
  }
  if (props.immediate === true) {
    appliedParts.value = Number.POSITIVE_INFINITY; // §5.2/PB §7.3: small-file sync swap, no staging
    return;
  }
  appliedParts.value = 0;
  batch = startHighlightBatches({
    total: p.length,
    next: nextCursor,
    root: () => {
      const el = codeEl.value?.$el;
      return el instanceof HTMLElement ? el : null;
    },
    apply: (_from, to) => {
      appliedParts.value = to;
    },
  });
});
onBeforeUnmount(() => {
  batch?.cancel();
  batch = null;
});
</script>

<template>
  <CodeLines ref="codeEl" :lines="lines" />
</template>
