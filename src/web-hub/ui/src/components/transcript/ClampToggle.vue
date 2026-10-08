<!--
  Shared "Show all / Collapse" toggle for `useCoarseClamp` regions (2026-10 transcript
  scroll-freeze fix, part 2). Renders NOTHING unless the passed handle says the content
  actually overflows its cap on a coarse pointer — on desktop the button is absent and the
  target element carries no `data-cc` attribute, so fine-pointer DOM stays byte-identical.
  Hosted inside `.thinking` (ThinkingBlock.vue) and `.tool-section` (ToolCard.vue) — both
  transcript-context, hence the `transcript.*` i18n keys.
-->
<script setup lang="ts">
import { useI18n } from "../../composables/useI18n.js";
import type { CoarseClampHandle } from "../../composables/useCoarseClamp.js";

defineProps<{ clamp: CoarseClampHandle }>();
const { t } = useI18n();
</script>

<template>
  <button
    v-if="clamp.toggleVisible"
    class="btn btn-ghost btn-xs cc-toggle"
    type="button"
    :aria-expanded="clamp.expanded ? 'true' : 'false'"
    @click="clamp.toggle()"
  >
    {{ clamp.expanded ? t("transcript.collapse") : t("transcript.showAll") }}
  </button>
</template>
