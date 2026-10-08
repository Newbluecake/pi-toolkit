<!--
  Text phase of the preview overlay (web-hub-preview plan v3 §4.6, package PV5; dir-plan
  v3.1 §4.1/§4.3, PM package): the body in a monospace `<pre>` (whitespace preserved,
  soft-wrapped by CSS), a truncated badge + note when the server clipped the body at
  `PREVIEW_TEXT_MAX_BYTES` (`X-PWH-Preview-Truncated`), and a copy button that copies
  exactly the DISPLAYED part (§4.6: "复制按钮复制的是已显示的部分" — `CopyButton`'s `value`
  is the shown source, never the path).

  Markdown rendering (B1–B7, PM package): a `.md`/`.markdown` path defaults to RENDERED —
  `@logic/markdown.js`'s whitelist parser → the transcript's own `MdBlock` renderer (the
  `md` class rides along so the shared `transcript.css` typography applies; no `v-html`
  anywhere, HTML/`javascript:` links/`![img]` stay literal text). A segmented rendered/
  source toggle (`aria-pressed`) switches to today's exact `<pre><HighlightedCode>` view;
  the Host remounts this component per `view.path` (`:key`), so every freshly opened file
  resets to rendered while a same-path retry keeps the current choice (B4, not persisted).
  A truncated md drops its incomplete final line (`prepareMarkdownPreview`) in BOTH modes
  and adds the "结尾可能不完整" note in rendered mode (B5). The AST node budget
  (`PREVIEW_MD_NODE_MAX`) forces source mode with a note + disabled rendered button (B7) —
  `HighlightedCode`'s own large-text degradation then covers the source view. Non-md files
  render the exact pre-change DOM (no toggle, no extra nodes).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { resolveFileLang } from "@logic/highlight.js";
import { parseMarkdown } from "@logic/markdown.js";
import { countMdNodes, isMarkdownPath, prepareMarkdownPreview, PREVIEW_MD_NODE_MAX } from "@logic/preview.js";
import CopyButton from "../detail/CopyButton.vue";
import MdBlock from "../transcript/MdBlock.vue";
import type { MdNode } from "../transcript/markdown-types.js";
import HighlightedCode from "../shared/HighlightedCode.vue";

const props = defineProps<{
  readonly text: string;
  readonly truncated: boolean;
  /** Host-formatted byte count of the shown body (drives the truncated note). */
  readonly sizeLabel?: string | undefined;
  /**
   * Basename of the previewed file (from `PreviewHost`'s header basename) — drives the
   * syntax-highlight language guess (`@logic/highlight.js`'s `resolveFileLang`). Absent /
   * unknown extension ⇒ plain text, DOM identical to pre-highlight.
   */
  readonly filename?: string | undefined;
  /** Full request path (PM package) — the markdown extension check runs on it (B1). */
  readonly path?: string | undefined;
}>();
const { t } = useI18n();
const highlightLang = computed(() => resolveFileLang(props.filename ?? ""));

// --- markdown mode (B1–B7) -------------------------------------------------------------
const isMd = computed(() => isMarkdownPath(props.path ?? props.filename ?? ""));
/** B5: shown source = raw body, minus a truncated md's incomplete final line. */
const shownSource = computed(() => (isMd.value ? prepareMarkdownPreview(props.text, props.truncated) : props.text));
/** B4: per-open mode (the Host's `:key="view.path"` resets it on every new file). */
const mode = ref<"rendered" | "source">("rendered");
const mdNodes = computed<readonly MdNode[] | null>(() =>
  isMd.value ? (parseMarkdown(shownSource.value) as readonly MdNode[]) : null,
);
/** B7: over the AST budget ⇒ forced source mode (rendered button disabled + note). */
const mdTooComplex = computed(() => mdNodes.value !== null && countMdNodes(mdNodes.value) > PREVIEW_MD_NODE_MAX);
/** B7 + B1: rendered only for an md file in rendered mode under the node budget; everything
 * else (non-md included — DOM identical to pre-change) renders the source view. */
const effectiveMode = computed<"rendered" | "source">(() =>
  isMd.value && mode.value === "rendered" && !mdTooComplex.value ? "rendered" : "source",
);
</script>

<template>
  <div class="preview-text">
    <p v-if="truncated" class="preview-truncated" role="note">
      <span class="preview-badge">{{ t("preview.truncatedBadge") }}</span>
      <span>{{
        effectiveMode === "rendered"
          ? t("preview.truncatedRenderNote", { size: sizeLabel ?? "" })
          : t("preview.truncatedNote", { size: sizeLabel ?? "" })
      }}</span>
    </p>
    <p v-if="mdTooComplex" class="preview-md-note" role="note">{{ t("preview.mdTooComplex") }}</p>
    <!-- rendered: `preview-md md` — `md` pulls in transcript.css's shared markdown typography -->
    <div v-if="effectiveMode === 'rendered'" class="preview-md md" tabindex="0"><MdBlock :nodes="mdNodes!" /></div>
    <pre
      v-else
      class="preview-text-body"
      tabindex="0"
    ><HighlightedCode :text="shownSource" :lang="highlightLang" /></pre>
    <div class="preview-text-actions">
      <div
        v-if="isMd"
        class="preview-toggle"
        role="group"
        :aria-label="t('preview.viewToggleLabel')"
        :title="mdTooComplex ? t('preview.mdTooComplex') : undefined"
      >
        <button
          type="button"
          class="preview-toggle-btn"
          :aria-pressed="effectiveMode === 'rendered'"
          :disabled="mdTooComplex"
          @click="mode = 'rendered'"
        >
          {{ t("preview.viewRendered") }}
        </button>
        <button
          type="button"
          class="preview-toggle-btn"
          :aria-pressed="effectiveMode === 'source'"
          @click="mode = 'source'"
        >
          {{ t("preview.viewSource") }}
        </button>
      </div>
      <CopyButton :value="shownSource" :label="t('common.copy')" />
    </div>
  </div>
</template>
