<!--
  Context-window usage meter (ui-design.md §5.2, §12, §13, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/detail/**`). A native `<meter>` (CSP `style-src 'self'` compliant —
  no `:style` percent binding needed at all) plus a percent readout and an optional
  `tokens / window` aside (hidden below 481px via `.hide-sm`, ui-design §5.2's mobile metrics
  simplification). `compact` drops the aside and uses the smaller `.meter` size instead of
  `.meter-lg` (mobile metrics band).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { formatNumber, formatPercent, localeFor } from "../../format.js";
import type { ContextMeterProps } from "../../contracts.js";

const props = defineProps<ContextMeterProps>();
const { t, lang } = useI18n();

const locale = computed(() => localeFor(lang));
const hasAside = computed(() => !props.compact && typeof props.tokens === "number" && typeof props.window === "number");
</script>

<template>
  <meter
    class="meter"
    :class="{ 'meter-lg': !compact }"
    min="0"
    max="100"
    low="70"
    high="85"
    optimum="0"
    :value="percent ?? 0"
    :aria-label="t('detail.contextAria')"
  ></meter>
  <span>{{ formatPercent(percent, locale) }}</span>
  <span v-if="hasAside" class="aside hide-sm"
    >{{ formatNumber(tokens, locale) }} / {{ formatNumber(window, locale) }}</span
  >
</template>
