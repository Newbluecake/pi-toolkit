<!--
  Dir phase of the preview overlay (dir-plan v3.1 §0.2 A1/§3.2, package P3): a directory
  listing rendered as keyboard-reachable native `<button>` rows — name (in `<bdi>`,
  `translate="no"`, so RTL/LTR-ambiguous names isolate and never translate), size (files
  only, `formatPreviewBytes`) and mtime. The hub already sorted (dir-first, name) and
  filtered (denylist entries are neither listed nor counted, §2.8) — this component renders
  the frozen `PreviewDirListing` verbatim.

  Row clickability (A3): `dir`/`file`/`symlink` rows are buttons (a symlink row goes through
  the full admission chain — the hub decides); FIFO/socket/device (`type:"other"`) and
  lossy-name (`lossy`, U+FFFD) rows render as inert grey text — never a dead button. A click
  only EMITS the entry; the navigation algebra (`childPreviewPath`, the history push) lives
  in the host + `usePreview`.

  Truncation/health copy (§3.2): the `limits` flags pick their notice lines (scan / entries /
  bytes — plus the filter-layer `dropped` count), `vanished`/`statPartial` get theirs, and
  the static footnote 「受保护条目不显示」 always renders (never a count — an existence
  oracle is exactly what §2.8 refuses to be). `complete:false` shows 「≥ total」. No
  innerHTML/v-html anywhere — text interpolation only.
-->
<script setup lang="ts">
import { computed } from "vue";
import { formatPreviewBytes } from "@logic/preview.js";
import {
  PREVIEW_DIR_SCAN_MAX,
  type PreviewDirEntry,
  type PreviewDirEntryType,
  type PreviewDirListing,
} from "@protocol/preview.js";
import { useI18n } from "../../composables/useI18n.js";
import { formatDateTime, formatNumber, localeFor } from "../../format.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  /** The listed directory's absolute path (A3 row joins derive from it in the host). */
  readonly path: string;
  readonly listing: PreviewDirListing;
}>();
const emit = defineEmits<{ (e: "navigate", entry: PreviewDirEntry): void }>();
const i18n = useI18n();
const { t } = i18n;

function typeLabel(type: PreviewDirEntryType): string {
  switch (type) {
    case "dir":
      return t("preview.dirTypeDir");
    case "file":
      return t("preview.dirTypeFile");
    case "symlink":
      return t("preview.dirTypeSymlink");
    default:
      return t("preview.dirTypeOther");
  }
}

interface RowView {
  readonly entry: PreviewDirEntry;
  /** A3: FIFO/socket/device (`other`) and lossy names never navigate. */
  readonly clickable: boolean;
  readonly isDot: boolean;
  readonly icon: "folder" | "file";
  readonly typeLabel: string;
  readonly sizeLabel: string;
  readonly mtimeLabel: string;
}

const rows = computed<RowView[]>(() =>
  props.listing.entries.map((entry): RowView => ({
    entry,
    clickable: entry.type !== "other" && entry.lossy !== true,
    isDot: entry.name.startsWith("."),
    icon: entry.type === "dir" ? "folder" : "file",
    typeLabel: typeLabel(entry.type),
    sizeLabel: entry.type === "file" ? formatPreviewBytes(entry.size) : "",
    mtimeLabel: formatDateTime(entry.mtimeMs ?? null, localeFor(i18n.lang)),
  })),
);

/** §3.2: `complete:false` ⇒ the scanned prefix is a lower bound — 「≥ total」. */
const countLabel = computed(() => {
  const L = props.listing;
  const n = formatNumber(L.total, localeFor(i18n.lang));
  return L.complete ? t("preview.dirCount", { n }) : t("preview.dirCountAtLeast", { n });
});

/** §3.2's fixed notice selection by `limits` (+ the filter layer's `dropped`). */
const notices = computed<string[]>(() => {
  const L = props.listing;
  const out: string[] = [];
  if (L.limits.scan)
    out.push(t("preview.dirLimitScan", { n: formatNumber(PREVIEW_DIR_SCAN_MAX, localeFor(i18n.lang)) }));
  if (L.limits.entries)
    out.push(
      t("preview.dirLimitEntries", {
        shown: formatNumber(L.entries.length, localeFor(i18n.lang)),
        total: formatNumber(L.total, localeFor(i18n.lang)),
      }),
    );
  if (L.limits.bytes) out.push(t("preview.dirLimitBytes", { n: formatNumber(L.entries.length, localeFor(i18n.lang)) }));
  if (L.dropped > 0) out.push(t("preview.dirDropped", { n: formatNumber(L.dropped, localeFor(i18n.lang)) }));
  if (L.vanished > 0) out.push(t("preview.dirVanished", { n: formatNumber(L.vanished, localeFor(i18n.lang)) }));
  if (L.statPartial === true) out.push(t("preview.dirStatPartial"));
  return out;
});
</script>

<template>
  <div class="preview-dir">
    <div class="preview-dir-meta" translate="no">
      <span>{{ countLabel }}</span>
    </div>
    <p v-for="(note, i) in notices" :key="i" class="preview-dir-note" role="note">{{ note }}</p>
    <p v-if="rows.length === 0" class="preview-dir-empty">{{ t("preview.dirEmpty") }}</p>
    <ul v-else class="preview-dir-list">
      <li v-for="row in rows" :key="row.entry.name" :class="{ 'is-dot': row.isDot }">
        <button
          v-if="row.clickable"
          class="preview-dir-row"
          type="button"
          :title="row.entry.name"
          @click="emit('navigate', row.entry)"
        >
          <AppIcon :name="row.icon" class="icon-sm preview-dir-row-icon" />
          <span class="sr-only">{{ row.typeLabel }} </span>
          <span class="preview-dir-name"
            ><bdi translate="no">{{ row.entry.name }}</bdi></span
          >
          <span class="preview-dir-size" translate="no">{{ row.sizeLabel }}</span>
          <span class="preview-dir-mtime" translate="no">{{ row.mtimeLabel }}</span>
        </button>
        <div v-else class="preview-dir-row is-inert" :title="row.entry.name">
          <AppIcon :name="row.icon" class="icon-sm preview-dir-row-icon" />
          <span class="sr-only">{{ row.typeLabel }} </span>
          <span class="preview-dir-name"
            ><bdi translate="no">{{ row.entry.name }}</bdi></span
          >
          <span class="preview-dir-size" translate="no">{{ row.sizeLabel }}</span>
          <span class="preview-dir-mtime" translate="no">{{ row.mtimeLabel }}</span>
        </div>
      </li>
    </ul>
    <!-- §2.8/A1: static, count-free — denylist hits are neither listed nor counted. -->
    <p class="preview-dir-footnote">{{ t("preview.dirProtected") }}</p>
  </div>
</template>
