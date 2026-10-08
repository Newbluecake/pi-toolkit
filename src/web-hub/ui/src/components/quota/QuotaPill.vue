<!--
  Top-bar subscription-quota pill (quota-web plan §3/D1/D6/D7). Self-contained: owns its own
  `open`/anchor state (same pattern as `TopBar.vue`'s gear + `SettingsOverlay`), so `TopBar.vue`
  only ever mounts this one component. Renders nothing (`v-if="view"`) when `quota` is absent or
  carries no providers/windows — the caller (`TopBar.vue`) additionally never mounts this
  component at all in that case (a `v-for` over a 0/1-item list, NOT a `v-if`, so the "off"
  state leaves literally zero extra DOM nodes — see `TopBar.vue`'s own comment for why a plain
  `v-if` cannot achieve that in Vue's compiled output).

  `nowTick` is the one local timer this package owns: every absolute timestamp (`resetAt`) is
  re-formatted from scratch each tick (D2 — the agent never re-pushes purposefully for a clock
  edge), at a 60s cadence (reset times are never shown to the minute of the *next* minute, so a
  shorter cadence buys nothing). Passed down to `QuotaCard` so both surfaces repaint in lockstep
  off one timer instead of two independently-phased ones.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { fmtResetAt, pillView, scopeLabel } from "@logic/quota.js";
import type { QuotaWire } from "@protocol/messages.js";
import QuotaCard from "./QuotaCard.vue";
import "../../styles/quota.css";

const props = defineProps<{ quota: QuotaWire | undefined }>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 767px)").matches;

const nowTick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now();
  }, 60_000);
});
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});

const view = computed(() => (props.quota !== undefined ? pillView(props.quota) : null));

const open = ref(false);
const btnEl = ref<HTMLButtonElement | null>(null);

function onToggle(): void {
  open.value = !open.value;
}
function onClose(): void {
  open.value = false;
}

function providerLabel(id: string): string {
  return t(`quota.provider.${id}`);
}

/** Pill annex reset text ("· {clock} reset"), or "" when no reset annex applies (D6). */
const resetAnnex = computed(() => {
  const v = view.value;
  if (v === null || v.resetAt === undefined) return "";
  const clock = fmtResetAt(v.resetAt, nowTick.value);
  return clock === undefined ? "" : ` · ${t("quota.resetSuffix", { clock })}`;
});

const pillText = computed(() => {
  const v = view.value;
  if (v === null) return "";
  if (mobile.value) return `${v.level === 3 ? "⚠ " : ""}${v.usedPct}%`;
  const head = v.level === 3 ? "⚠" : providerLabel(v.providerId);
  return `${head} ${scopeLabel(v.scope)} ${v.usedPct}%${resetAnnex.value}`;
});

const ariaLabel = computed(() => {
  const v = view.value;
  if (v === null) return "";
  const provider = providerLabel(v.providerId);
  const scope = scopeLabel(v.scope);
  if (v.resetAt !== undefined) {
    const clock = fmtResetAt(v.resetAt, nowTick.value);
    if (clock !== undefined) return t("quota.pillAriaReset", { provider, scope, pct: v.usedPct, clock });
  }
  return t("quota.pillAriaBase", { provider, scope, pct: v.usedPct });
});
</script>

<template>
  <span v-if="view" class="q-anchor">
    <button
      ref="btnEl"
      type="button"
      class="q-pill"
      :data-level="view.level"
      aria-haspopup="dialog"
      :aria-expanded="open"
      aria-controls="quota-panel"
      :aria-label="ariaLabel"
      :title="ariaLabel"
      @click="onToggle"
    >
      <span class="q-dot" aria-hidden="true"></span>
      <span class="q-pill-text">{{ pillText }}</span>
    </button>
    <QuotaCard v-if="open && quota" :quota="quota" :now="nowTick" :anchor-el="btnEl" @close="onClose" />
  </span>
</template>
