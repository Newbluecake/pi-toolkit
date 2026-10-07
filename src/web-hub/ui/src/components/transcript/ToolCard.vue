<!--
  Tool call card (ui-design.md §5.4, vue-plan.md v2.1 §3.1/§5.2 — P4): a `<details>` summary
  (state icon, name, one-line args summary, truncated badge, chevron) expanding to Input / Live
  output / Output sections. `summarizeArgs`/`safeJson` are the tested `@logic/render/tools.js`
  pure functions, reused unchanged. A running call's `partial` is tail-truncated to 200 lines /
  16 KiB (`tail-lines.ts`, ui-design.md §6.6) with a "Show full output" toggle that switches to
  the full text (still held in full in `state`, per the plan — this only gates what's *rendered*).

  PV6 (web-hub-preview plan v3 修订 7): ONLY the Input section's `argsText` `<pre>` renders
  through `PathText` (plain-text mode — read/edit/bash args carry absolute paths worth
  previewing). The summary line stays untouched (`<summary>` click semantics conflict with the
  details toggle), and Live/Output stay plain (read-only preview has no jump value there).
  With no preview ctx/scope the `<pre>`'s DOM is identical to before, so select-all/copy are
  unaffected.

  Edit-diff view (2026-10 用户需求「edit 直接呈现改了哪些内容」): an `edit` call whose args
  parse (`@logic/diff.js`'s `buildEditDiff`) swaps the Input section's raw JSON for a
  unified-diff presentation — hunk header `编辑 N/M`, `-`/`+` rows with inline marks, the file
  path still through `PathText`. A hunk over `DIFF_FOLD.threshold` rows renders folded
  (head/tail around a `… N rows omitted` marker whose Expand button flips per-hunk state);
  any parse miss keeps the raw-JSON `<pre>` byte-identical to before.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { buildEditDiff, foldRows } from "@logic/diff.js";
import { safeJson, summarizeArgs } from "@logic/tools.js";
import type { ToolCardProps } from "../../contracts.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import PathText from "../preview/PathText.vue";
import { tailLines } from "./tail-lines.js";

const props = defineProps<ToolCardProps>();
const { t } = useI18n();

const TOOL_STATE_ICON = { pending: "clock", running: "loader", done: "check", error: "x" } as const;
const TOOL_STATE_ATTR = { pending: "pending", running: "running", done: "done", error: "failed" } as const;

const icon = computed(() => TOOL_STATE_ICON[props.view.state]);
const dataSt = computed(() => TOOL_STATE_ATTR[props.view.state]);
const spins = computed(() => props.view.state === "running");
const argsText = computed(() => {
  const args = props.view.args;
  if (args === undefined) return undefined;
  return typeof args === "string" ? args : safeJson(args, true);
});
const endLabel = computed(() => {
  const v = props.view;
  if (v.state === "error") return t("transcript.tool.error");
  if (v.state === "done" && typeof v.result === "string") {
    const n = v.result === "" ? 0 : v.result.split("\n").length;
    return t("transcript.tool.lines", { n });
  }
  return "";
});

const showFullPartial = ref(false);
const partialTail = computed(() => tailLines(props.view.partial ?? ""));
const displayedPartial = computed(() => (showFullPartial.value ? (props.view.partial ?? "") : partialTail.value.text));
const partialIsTruncated = computed(() => !showFullPartial.value && partialTail.value.truncated);

type EditDiff = NonNullable<ReturnType<typeof buildEditDiff>>;
type DiffHunk = EditDiff["edits"][number];
type DiffRow = DiffHunk["rows"][number];

const editDiff = computed(() => buildEditDiff(props.view.toolName, props.view.args));

/** Per-hunk expand state for the fold guard — index-aligned with `editDiff.edits`. */
const expandedHunks = ref<boolean[]>([]);

function displayRows(hunk: DiffHunk, index: number): DiffRow[] {
  return expandedHunks.value[index] === true ? hunk.rows : foldRows(hunk.rows).rows;
}

function expandHunk(index: number): void {
  expandedHunks.value[index] = true;
}

const hasBody = computed(
  () =>
    argsText.value !== undefined ||
    (props.view.partial !== undefined && props.view.partial !== "") ||
    props.view.result !== undefined,
);
</script>

<template>
  <details class="tool" :class="`tool-${view.state}`" :data-st="dataSt" :data-key="view.toolCallId">
    <summary class="tool-head">
      <span v-if="view.state === 'running'" class="tool-progress" aria-hidden="true"></span>
      <span class="run-icon"><AppIcon :name="icon" :class="{ spin: spins }" /></span>
      <span class="tool-name" translate="no">{{ view.toolName }}</span>
      <span class="tool-args" translate="no">{{ summarizeArgs(view.args) }}</span>
      <span v-if="view.truncated" class="badge badge-trunc" :title="t('transcript.truncatedTitle')">{{
        t("transcript.truncated")
      }}</span>
      <span v-if="endLabel" class="tool-end"
        ><span>{{ endLabel }}</span></span
      >
      <AppIcon name="chev-right" class="icon icon-sm chev" />
    </summary>
    <div v-if="hasBody" class="tool-body">
      <div v-if="editDiff !== null" class="tool-section">
        <div class="tool-label">{{ t("transcript.tool.input") }}</div>
        <div class="diff" translate="no">
          <div v-if="editDiff.path !== null" class="diff-path"><PathText :text="editDiff.path" /></div>
          <div v-for="(hunk, hi) in editDiff.edits" :key="hi" class="diff-hunk">
            <div class="diff-hunk-head">
              {{ t("transcript.tool.diffEdit", { i: hi + 1, m: editDiff.edits.length }) }}
            </div>
            <template v-for="(row, ri) in displayRows(hunk, hi)" :key="ri">
              <div v-if="row.kind === 'fold'" class="diff-row diff-fold-row">
                <span class="diff-fold-text">{{ t("transcript.tool.diffFold", { n: row.count }) }}</span>
                <button class="btn btn-ghost btn-xs" type="button" @click="expandHunk(hi)">
                  {{ t("transcript.tool.diffExpand") }}
                </button>
              </div>
              <div v-else-if="row.kind === 'common'" class="diff-row diff-ctx">
                <span class="diff-sign" aria-hidden="true"></span><span class="diff-text">{{ row.text }}</span>
              </div>
              <div v-else :class="row.kind === 'del' ? 'diff-row diff-del' : 'diff-row diff-add'">
                <span class="diff-sign" aria-hidden="true">{{ row.kind === "del" ? "-" : "+" }}</span
                ><span class="diff-text"
                  ><span
                    v-for="(seg, si) in row.segs"
                    :key="si"
                    :class="
                      seg.hl ? (row.kind === 'del' ? 'diff-mark diff-mark-del' : 'diff-mark diff-mark-add') : undefined
                    "
                    >{{ seg.text }}</span
                  ></span
                >
              </div>
            </template>
          </div>
        </div>
      </div>
      <div v-else-if="argsText !== undefined" class="tool-section">
        <div class="tool-label">{{ t("transcript.tool.input") }}</div>
        <pre class="pre" translate="no" tabindex="0"><PathText v-if="argsText !== undefined" :text="argsText" /></pre>
      </div>
      <div v-if="view.partial !== undefined && view.partial !== ''" class="tool-section">
        <div class="tool-label">
          {{ t("transcript.tool.liveOutput") }}
          <button v-if="partialIsTruncated" class="btn btn-ghost btn-xs" type="button" @click="showFullPartial = true">
            {{ t("transcript.tool.showFull") }}
          </button>
        </div>
        <pre class="pre" translate="no" tabindex="0">{{ displayedPartial }}</pre>
      </div>
      <div v-if="view.result !== undefined" class="tool-section" :class="{ 'is-error': view.state === 'error' }">
        <div class="tool-label">
          {{ view.state === "error" ? t("transcript.tool.result") : t("transcript.tool.output") }}
        </div>
        <pre class="pre" translate="no" tabindex="0">{{ view.result }}</pre>
      </div>
    </div>
  </details>
</template>
