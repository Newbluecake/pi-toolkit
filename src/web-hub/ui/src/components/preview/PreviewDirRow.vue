<!--
  One directory row's interactive body (dir-plan v3.1 §0.2 A1/A3; factored out of
  PreviewDirRows for the preview-tree conditional wrapper): a clickable row renders the
  native `<button>` (name in `<bdi translate="no">`, size, mtime); an inert row
  (`other`/lossy) renders the grey text div — never a dead button. The component's ROOT is
  the button/div itself (no wrapper element), so a tree-less PreviewDirRows keeps the
  pre-tree `li > button.preview-dir-row` DOM byte-identical.
-->
<script lang="ts">
import type { PreviewDirEntry } from "@protocol/preview.js";

/** The pre-computed view model of one row (built by PreviewDirRows). */
export interface DirRowView {
  readonly entry: PreviewDirEntry;
  readonly clickable: boolean;
  readonly icon: "folder" | "file";
  readonly typeLabel: string;
  readonly sizeLabel: string;
  readonly mtimeLabel: string;
}
</script>

<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{ readonly row: DirRowView }>();
const emit = defineEmits<{
  (e: "navigate", entry: PreviewDirEntry): void;
  /** Forwarded native keydown — PreviewDirRows hangs the tree arrow-key ops on it. */
  (e: "rowkeydown", ev: KeyboardEvent): void;
}>();
</script>

<template>
  <button
    v-if="props.row.clickable"
    class="preview-dir-row"
    type="button"
    :title="props.row.entry.name"
    @click="emit('navigate', props.row.entry)"
    @keydown="emit('rowkeydown', $event)"
  >
    <AppIcon :name="props.row.icon" class="icon-sm preview-dir-row-icon" />
    <span class="sr-only">{{ props.row.typeLabel }} </span>
    <span class="preview-dir-name"
      ><bdi translate="no">{{ props.row.entry.name }}</bdi></span
    >
    <span class="preview-dir-size" translate="no">{{ props.row.sizeLabel }}</span>
    <span class="preview-dir-mtime" translate="no">{{ props.row.mtimeLabel }}</span>
  </button>
  <div v-else class="preview-dir-row is-inert" :title="props.row.entry.name">
    <AppIcon :name="props.row.icon" class="icon-sm preview-dir-row-icon" />
    <span class="sr-only">{{ props.row.typeLabel }} </span>
    <span class="preview-dir-name"
      ><bdi translate="no">{{ props.row.entry.name }}</bdi></span
    >
    <span class="preview-dir-size" translate="no">{{ props.row.sizeLabel }}</span>
    <span class="preview-dir-mtime" translate="no">{{ props.row.mtimeLabel }}</span>
  </div>
</template>
