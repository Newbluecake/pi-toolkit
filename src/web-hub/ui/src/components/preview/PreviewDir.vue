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

  preview-tree (2026-10 用户需求): the row list itself moved to the recursive
  `PreviewDirRows.vue` — every dir row grows a chevron for INLINE expansion (lazy `dir=1`
  fetch on first expand via the same endpoint, per-path cache in the injected `tree` store,
  折叠不丢), while the row-name button keeps its drill-down `navigate` emit unchanged.
  The store lives on `usePreview`'s per-visit handle, so the host's `:key="view.path"`
  remount on drill/back does NOT lose expansions; a fresh open/close drops them
  (弹窗关闭即弃). Budget refusals (`tree.refusal`) render as one inline notice line —
  never a new dialog. Without the `tree` prop (legacy fakes) the rows render byte-identical
  to pre-tree DOM (no chevrons, no tree roles).

  Path bar (tilde-expansion addendum, part B): a native `<form>` + `<input>` pre-filled with
  `props.path` — submitting emits `go` with trimmed text after local byte/control checks;
  the host re-runs the FULL admission chain on the hub for whatever comes back (no
  client-side trust — a syntactically-invalid or denied path just surfaces through the
  existing error/unsupported view, same as any other failed navigation). Esc restores the
  draft to `props.path` and stops propagation so it does NOT also close the whole dialog
  (the overlay's own Esc-closes-everything handler lives one level up, in PreviewHost).

  Truncation/health copy (§3.2): the `limits` flags pick their notice lines (scan / entries /
  bytes — plus the filter-layer `dropped` count), `vanished`/`statPartial` get theirs, and
  the static footnote 「受保护条目不显示」 always renders (never a count — an existence
  oracle is exactly what §2.8 refuses to be). `complete:false` shows 「≥ total」. No
  innerHTML/v-html anywhere — text interpolation only.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  PREVIEW_DIR_SCAN_MAX,
  PREVIEW_PATH_MAX_BYTES,
  type PreviewDirEntry,
  type PreviewDirListing,
} from "@protocol/preview.js";
import {
  PREVIEW_TREE_MAX_ENTRIES,
  PREVIEW_TREE_MAX_EXPANDED,
  type PreviewTreeStore,
} from "../../composables/usePreviewTree.js";
import { useI18n } from "../../composables/useI18n.js";
import { formatNumber, localeFor } from "../../format.js";
import PreviewDirRows from "./PreviewDirRows.vue";

const props = defineProps<{
  /** The listed directory's absolute path (A3 row joins derive from it in the host). */
  readonly path: string;
  readonly listing: PreviewDirListing;
  /** preview-tree: the per-visit inline-expansion store (absent ⇒ no chevrons). */
  readonly tree?: PreviewTreeStore | undefined;
}>();
const emit = defineEmits<{
  (e: "navigate", entry: PreviewDirEntry, parentPath: string): void;
  (e: "go", path: string): void;
}>();
const i18n = useI18n();
const { t } = i18n;

// Path bar (part B): pre-filled with the listed directory's own path; re-filled whenever a
// fresh listing arrives (a new `path` prop — PreviewHost `:key="view.path"` already remounts
// this whole component per navigation anyway, but the watch keeps it correct even if that
// ever changes). Local checks do not replace the hub's authoritative admission chain.
const pathDraft = ref(props.path);
const pathError = ref<"forbidden" | "tooLong" | null>(null);
const textEncoder = new TextEncoder();
watch(
  pathDraft,
  () => {
    pathError.value = null;
  },
  { flush: "sync" },
);
watch(
  () => props.path,
  (p) => {
    pathDraft.value = p;
  },
);

function submitPathBar(): void {
  // Check before trimming: CR/LF must never silently disappear from a request.
  if (/[\0\r\n]/.test(pathDraft.value)) {
    pathError.value = "forbidden";
    return;
  }
  if (textEncoder.encode(pathDraft.value).length > PREVIEW_PATH_MAX_BYTES) {
    pathError.value = "tooLong";
    return;
  }
  pathError.value = null;
  const raw = pathDraft.value.trim();
  if (raw === "") return;
  emit("go", raw);
}

function resetPathBar(): void {
  pathDraft.value = props.path;
}

/** preview-tree: the store's budget refusal as one inline notice line (never a dialog). */
const refusalLabel = computed(() => {
  const r = props.tree?.refusal.value;
  if (r === "dirs")
    return t("preview.dirTreeLimitDirs", { n: formatNumber(PREVIEW_TREE_MAX_EXPANDED, localeFor(i18n.lang)) });
  if (r === "entries")
    return t("preview.dirTreeLimitEntries", { n: formatNumber(PREVIEW_TREE_MAX_ENTRIES, localeFor(i18n.lang)) });
  return null;
});

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
    <form class="preview-dir-pathbar" @submit.prevent="submitPathBar">
      <input
        v-model="pathDraft"
        type="text"
        class="input preview-dir-pathbar-input"
        :aria-label="t('preview.dirPathLabel')"
        :placeholder="t('preview.dirPathPlaceholder')"
        :aria-invalid="pathError ? 'true' : undefined"
        :aria-describedby="pathError ? 'preview-dir-path-error' : undefined"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        translate="no"
        @keydown.esc.stop.prevent="resetPathBar"
      />
      <button type="submit" class="btn preview-dir-pathbar-go" :aria-label="t('preview.dirPathGo')">
        {{ t("preview.dirPathGo") }}
      </button>
    </form>
    <p v-if="pathError" id="preview-dir-path-error" class="preview-dir-note" role="alert">
      {{
        pathError === "forbidden"
          ? t("preview.dirPathForbidden")
          : t("preview.dirPathTooLong", { max: PREVIEW_PATH_MAX_BYTES })
      }}
    </p>
    <div class="preview-dir-meta" translate="no">
      <span>{{ countLabel }}</span>
    </div>
    <p v-for="(note, i) in notices" :key="i" class="preview-dir-note" role="note">{{ note }}</p>
    <!-- preview-tree: budget refusal — inline lightweight hint, cleared by the next toggle. -->
    <p v-if="refusalLabel !== null" class="preview-dir-note preview-dir-tree-refusal" role="status">
      {{ refusalLabel }}
    </p>
    <p v-if="listing.entries.length === 0" class="preview-dir-empty">{{ t("preview.dirEmpty") }}</p>
    <PreviewDirRows
      v-else
      root
      :parent-path="path"
      :entries="listing.entries"
      :depth="1"
      :tree="tree"
      @navigate="(entry, parentPath) => emit('navigate', entry, parentPath)"
    />
    <!-- §2.8/A1: static, count-free — denylist hits are neither listed nor counted. -->
    <p class="preview-dir-footnote">{{ t("preview.dirProtected") }}</p>
  </div>
</template>
