<!--
  Text phase of the preview overlay (web-hub-preview plan v3 §4.6, package PV5): the body in
  a monospace `<pre>` (whitespace preserved, soft-wrapped by CSS), a truncated badge + note
  when the server clipped the body at `PREVIEW_TEXT_MAX_BYTES` (`X-PWH-Preview-Truncated`),
  and a copy button that copies exactly the DISPLAYED part (§4.6: "复制按钮复制的是已显示的
  部分" — `CopyButton`'s `value` is `text`, never the path).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { resolveFileLang } from "@logic/highlight.js";
import CopyButton from "../detail/CopyButton.vue";
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
}>();
const { t } = useI18n();
const highlightLang = computed(() => resolveFileLang(props.filename ?? ""));
</script>

<template>
  <div class="preview-text">
    <p v-if="truncated" class="preview-truncated" role="note">
      <span class="preview-badge">{{ t("preview.truncatedBadge") }}</span>
      <span>{{ t("preview.truncatedNote", { size: sizeLabel ?? "" }) }}</span>
    </p>
    <pre class="preview-text-body" tabindex="0"><HighlightedCode :text="text" :lang="highlightLang" /></pre>
    <div class="preview-text-actions">
      <CopyButton :value="text" :label="t('common.copy')" />
    </div>
  </div>
</template>
