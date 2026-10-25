<!--
  MdPreviewBody.vue — J1 #5 (jank-20kb, md cold open): the RENDERED markdown body's
  progressive MOUNT. `parseMarkdown` itself stays synchronous (PreviewText's complexity
  gate + toggle need the AST), but mounting every block of a 26 KB document in the open
  flush measured 496 ms cold @4× CPU (one longtask: parse + full MdBlock mount + ~20
  fences' debounced tokenizes). This wrapper mounts only the LEADING blocks on the first
  frame, then grows in idle-scheduled batches — append-only, so existing DOM (and any
  selection in it) is never rewritten, scroll position never shifts, and the FINAL DOM is
  byte-identical to a plain `<MdBlock :nodes>` (it IS one, over a growing prefix slice;
  MdBlock's index-keyed v-for appends without touching mounted rows).

  Not used by the STREAM rendered view (previewStream's per-segment MdBlocks already mount
  incrementally as chunks arrive) nor the transcript. The fence tokenizes ride J1 #1's
  shared worker path through MdBlock → CodeBlock → HighlightedCode like every other body.
-->
<script lang="ts">
/** First frame mounts at most this many top-level blocks (≈ the first screenful — the
 *  md-24k cold open must stay under a 150 ms freeze at 4× CPU; the rest lands in idle
 *  batches). */
export const MD_PREVIEW_FIRST_BLOCKS = 8;
/** …then idle batches of this many (append-only; the final DOM matches a full mount). */
export const MD_PREVIEW_BATCH_BLOCKS = 24;
</script>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import MdBlock from "../transcript/MdBlock.vue";
import type { MdNode } from "../transcript/markdown-types.js";
import { scheduleIdleTask } from "../shared/highlight-core.js";

const props = defineProps<{ readonly nodes: readonly MdNode[] }>();

const mountedCount = ref(0);
let idleCancel: (() => void) | null = null;

function dropIdle(): void {
  if (idleCancel !== null) {
    idleCancel();
    idleCancel = null;
  }
}

/** (Re)start for the current node list: leading blocks now, the rest in idle batches. */
function start(): void {
  dropIdle();
  const total = props.nodes.length;
  mountedCount.value = Math.min(total, MD_PREVIEW_FIRST_BLOCKS);
  if (mountedCount.value >= total) return;
  const step = (): void => {
    idleCancel = null;
    const now = props.nodes.length;
    if (mountedCount.value >= now) return;
    mountedCount.value = Math.min(now, mountedCount.value + MD_PREVIEW_BATCH_BLOCKS);
    if (mountedCount.value >= now) return;
    idleCancel = scheduleIdleTask(step, { timeout: 400 });
  };
  idleCancel = scheduleIdleTask(step, { timeout: 400 });
}

watch(() => props.nodes, start, { immediate: true });
onBeforeUnmount(dropIdle);

/** A growing PREFIX of the node list — MdBlock over the slice, append-only. */
const shown = computed(() => props.nodes.slice(0, mountedCount.value));
</script>

<template>
  <MdBlock :nodes="shown" />
</template>
