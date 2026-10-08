<!--
  worktree-diff plan v3.1 §3.4/§3.5/§3.7/§4.3 (package D5): the dumb row renderer for the diff
  dialog's body — one element per row, four cells on ONE grid template (`lnL | txL | lnR | txR`
  split, `lnOld | lnNew | sign | text` unified; D10: a long line wraps inside its own row, so
  both halves of a pair stay equal-height). Row grammar comes straight from D2's
  `buildSplitRows`/`buildUnifiedRows`; this component never re-derives alignment.

  §3.7 caps live here: per-line `clipLine` (WTDIFF_LINE_DISPLAY_MAX code points, `…(+N)`
  marker), a trailing `\r` rendered as the dim `␍` glyph, `noEol` as a dim trailing token, and
  first-paint pagination (`pageRows`, default `WTDIFF_RENDER_PAGE_ROWS`; 「显示更多」 appends
  another page — never virtual scrolling, §8). Pagination resets when the `rows` array identity
  changes (a new file load).

  A11y: del/add text cells carry an sr-only「删除」/「新增」prefix (colors alone never carry the
  semantics); paired EMPTY cells are `aria-hidden` decoration; line numbers are
  `user-select: none`. Everything is plain-text interpolation — no `v-html`, ever.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { clipLine, displayPath, WTDIFF_RENDER_PAGE_ROWS } from "@logic/wtdiff.js";
import { useI18n } from "../../composables/useI18n.js";

/** D2's row grammar, re-declared structurally for the template (the builders are the source of
 * truth; alignment is pinned by `tests/web-hub/ui/logic-wtdiff.test.ts`). Unified line rows
 * carry `sign` — that field is also the template's discriminant between the two grammars. */
interface PatchLineLike {
  readonly k: "ctx" | "del" | "add";
  readonly o: number | null;
  readonly n: number | null;
  readonly text: string;
  readonly noEol?: true;
}
interface PatchMetaLike {
  readonly newFile?: true;
  readonly deleted?: true;
  readonly renameFrom?: string;
  readonly renameTo?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly similarity?: number;
  readonly binary?: true;
}
interface RowFile {
  readonly t: "file";
  readonly meta: PatchMetaLike;
}
interface RowHunk {
  readonly t: "hunk";
  readonly text: string;
}
interface SplitRowCtx {
  readonly t: "ctx";
  readonly o: number;
  readonly n: number;
  readonly text: string;
  readonly noEol?: true;
}
interface SplitRowPair {
  readonly t: "pair";
  readonly l: PatchLineLike | null;
  readonly r: PatchLineLike | null;
}
interface UnifiedRowLine {
  readonly t: "ctx" | "del" | "add";
  readonly o: number | null;
  readonly n: number | null;
  readonly sign: string;
  readonly text: string;
  readonly noEol?: true;
}
type Row = RowFile | RowHunk | SplitRowCtx | SplitRowPair | UnifiedRowLine;

const props = withDefaults(
  defineProps<{
    readonly rows: readonly Row[];
    readonly mode: "split" | "unified";
    readonly pageRows?: number;
    /** Current HEAD oid (the diff's base) — drives the 旧-side header's `base` segment. */
    readonly base?: string;
  }>(),
  { pageRows: WTDIFF_RENDER_PAGE_ROWS },
);
const { t } = useI18n();

/** §3.7 pagination state; resets per load (`rows` identity change = a new file). */
const shown = ref(props.pageRows);
watch(
  () => props.rows,
  () => {
    shown.value = props.pageRows;
  },
);

const visible = computed(() => props.rows.slice(0, shown.value));
const remaining = computed(() => Math.max(0, props.rows.length - shown.value));

function showMore(): void {
  shown.value += props.pageRows;
}

/** §3.7 display pipeline for one line of text: code-point clip, then a trailing `\r` becomes
 * the dim `␍` glyph (rendered as a separate span so the text node itself stays selectable). */
function lineText(text: string): { body: string; cr: boolean } {
  const clipped = clipLine(text);
  if (clipped.text.endsWith("\r")) return { body: clipped.text.slice(0, -1), cr: true };
  return { body: clipped.text, cr: false };
}

/** §3.3/§4.2 multi-file block header label: rename arrow, new/deleted/binary tokens, mode
 * change, similarity — compact tokens, path parts control-character-visualized. */
function metaParts(m: PatchMetaLike): string {
  const parts: string[] = [];
  if (m.renameFrom !== undefined || m.renameTo !== undefined) {
    parts.push(`${displayPath(m.renameFrom ?? "?")} → ${displayPath(m.renameTo ?? "?")}`);
  }
  if (m.newFile === true) parts.push(t("diff.metaNewFile"));
  if (m.deleted === true) parts.push(t("diff.metaDeleted"));
  if (m.binary === true) parts.push(t("diff.metaBinary"));
  if (m.oldMode !== undefined && m.newMode !== undefined && m.oldMode !== m.newMode) {
    parts.push(t("diff.metaMode", { a: m.oldMode, b: m.newMode }));
  }
  if (m.similarity !== undefined) parts.push(`${m.similarity}%`);
  return parts.length > 0 ? parts.join(" · ") : "diff";
}
</script>

<template>
  <div class="wtd-rows" :data-mode="mode">
    <!-- §4.3 split side heads (旧 · base7 / 新 · 工作区), sticky at the scroll top. -->
    <div v-if="mode === 'split'" class="wtd-row wtd-split-head" aria-hidden="true">
      <span class="wtd-cell wtd-span">{{ t("diff.oldSide", { base: (base ?? "").slice(0, 7) }) }}</span>
      <span class="wtd-cell wtd-span">{{ t("diff.newSide") }}</span>
    </div>
    <div v-for="(row, i) in visible" :key="`${i}:${row.t}`" class="wtd-row" :data-t="row.t">
      <!-- block header (multi-file patch) / hunk header: one cell spanning the row -->
      <span v-if="row.t === 'file'" class="wtd-cell wtd-span wtd-fileh" translate="no">{{ metaParts(row.meta) }}</span>
      <span v-else-if="row.t === 'hunk'" class="wtd-cell wtd-span wtd-hunk" translate="no">{{ row.text }}</span>
      <!-- §3.4 split ctx: the same text on both sides, each with its own line number -->
      <template v-else-if="mode === 'split' && row.t === 'ctx'">
        <span class="wtd-cell wtd-ln">{{ row.o }}</span>
        <span class="wtd-cell wtd-tx"
          >{{ lineText(row.text).body }}<span v-if="lineText(row.text).cr" class="wtd-cr">␍</span
          ><span v-if="row.noEol === true" class="wtd-noeol">{{ t("diff.noEol") }}</span></span
        >
        <span class="wtd-cell wtd-ln">{{ row.n }}</span>
        <span class="wtd-cell wtd-tx"
          >{{ lineText(row.text).body }}<span v-if="lineText(row.text).cr" class="wtd-cr">␍</span
          ><span v-if="row.noEol === true" class="wtd-noeol">{{ t("diff.noEol") }}</span></span
        >
      </template>
      <!-- §3.4 split pair: zip-aligned del (left) / add (right), the shorter side padded with
           aria-hidden empty cells — 空位只在段内出现，ctx 行重新对齐两侧 (D10) -->
      <template v-else-if="mode === 'split' && row.t === 'pair'">
        <template v-if="row.l !== null">
          <span class="wtd-cell wtd-ln">{{ row.l.o }}</span>
          <span class="wtd-cell wtd-tx wtd-del"
            ><span class="sr-only">{{ `${t("diff.srDel")} ` }}</span
            >{{ lineText(row.l.text).body }}<span v-if="lineText(row.l.text).cr" class="wtd-cr">␍</span
            ><span v-if="row.l.noEol === true" class="wtd-noeol">{{ t("diff.noEol") }}</span></span
          >
        </template>
        <template v-else>
          <span class="wtd-cell wtd-ln wtd-empty" aria-hidden="true"></span>
          <span class="wtd-cell wtd-tx wtd-empty" aria-hidden="true"></span>
        </template>
        <template v-if="row.r !== null">
          <span class="wtd-cell wtd-ln">{{ row.r.n }}</span>
          <span class="wtd-cell wtd-tx wtd-add"
            ><span class="sr-only">{{ `${t("diff.srAdd")} ` }}</span
            >{{ lineText(row.r.text).body }}<span v-if="lineText(row.r.text).cr" class="wtd-cr">␍</span
            ><span v-if="row.r.noEol === true" class="wtd-noeol">{{ t("diff.noEol") }}</span></span
          >
        </template>
        <template v-else>
          <span class="wtd-cell wtd-ln wtd-empty" aria-hidden="true"></span>
          <span class="wtd-cell wtd-tx wtd-empty" aria-hidden="true"></span>
        </template>
      </template>
      <!-- §3.5 unified: lnOld | lnNew | sign | text (`'sign' in row` = the unified grammar) -->
      <template v-else-if="'sign' in row">
        <span class="wtd-cell wtd-ln">{{ row.o }}</span>
        <span class="wtd-cell wtd-ln">{{ row.n }}</span>
        <span class="wtd-cell wtd-sign" :class="`is-${row.t}`" aria-hidden="true">{{ row.sign }}</span>
        <span class="wtd-cell wtd-tx" :class="`is-${row.t}`"
          ><span v-if="row.t !== 'ctx'" class="sr-only">{{
            row.t === "del" ? `${t("diff.srDel")} ` : `${t("diff.srAdd")} `
          }}</span
          >{{ lineText(row.text).body }}<span v-if="lineText(row.text).cr" class="wtd-cr">␍</span
          ><span v-if="row.noEol === true" class="wtd-noeol">{{ t("diff.noEol") }}</span></span
        >
      </template>
    </div>
    <div v-if="remaining > 0" class="wtd-more-row">
      <button class="btn wtd-more" type="button" @click="showMore">{{ t("diff.showMore", { n: remaining }) }}</button>
    </div>
  </div>
</template>
