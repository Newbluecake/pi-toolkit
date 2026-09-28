<!--
  Hub-state banner (control-plan.md v2.1 §6.6/§6.7, §7.7 — C5 exclusive, `components/shell/**`).
  Mounted once by App.vue under the TopBar; reads `HUB_CTX.state` (the reducer's hub frame
  fields) and renders exactly one state, in priority order:

    stopping          ⇒ "hub 已由终端停止，/webhub start 恢复" (§6.7.2 前端行)
    restarting        ⇒ "hub 正在升级到 vX" — `forced` adds the >30min forced copy, `draining`
                        the drain note (§6.7.3 网页语义)
    supersedePending  ⇒ collapsible one-liner "hub 将在空闲时升级到 vX（最晚 HH:MM）" with a
                        live countdown off `supersedeDeadlineAt` (v2.1 §7.7)

  Hidden entirely while the hub is plain `running`. The countdown ticks off the P1 `useTicker`
  (hidden-page-aware, no rAF).
-->
<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useTicker } from "../../composables/useTicker.js";
import AppIcon from "../../icons/AppIcon.vue";
import { HUB_CTX } from "../control/controlContext.js";

const { t } = useI18n();
const hub = inject(HUB_CTX, null);

const ticker = useTicker({
  doc: document,
  win: window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  now: () => Date.now(),
});

const state = computed(() => hub?.state.value);
const hubState = computed(() => state.value?.hubState);
const nextVersion = computed(() => state.value?.nextVersion);
const supersedePending = computed(() => state.value?.supersedePending === true);
const forced = computed(() => state.value?.forced === true);
const draining = computed(() => state.value?.draining === true);

const mode = computed<"stopping" | "restarting" | "pending" | null>(() => {
  if (hubState.value === "stopping") return "stopping";
  if (hubState.value === "restarting") return "restarting";
  if (supersedePending.value) return "pending";
  return null;
});

/** "最晚 HH:MM" — local 24h clock; past deadlines clamp to "now" (the hub's own deadline is
 * authoritative, this line is informational). */
const deadlineLabel = computed(() => {
  const at = state.value?.supersedeDeadlineAt;
  if (typeof at !== "number") return "";
  void ticker.now.value; // tick dependency — re-evaluates once a second while visible
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
});

const expanded = ref(false);
</script>

<template>
  <div v-if="mode !== null" class="hub-state-banner" :data-state="mode" role="status" :aria-label="t('hub.bannerAria')">
    <AppIcon v-if="mode === 'stopping'" name="unplug" class="icon-sm" />
    <AppIcon v-else name="loader" class="icon-sm" :class="{ spin: mode === 'restarting' }" />
    <span class="hub-state-text">
      <template v-if="mode === 'stopping'">{{ t("hub.stopped") }}</template>
      <template v-else-if="mode === 'restarting'">
        {{ t("hub.restarting", { v: nextVersion ?? "?" }) }}
        <span v-if="forced" class="hub-state-sub">{{ t("hub.forcedUpgrade") }}</span>
        <span v-else-if="draining" class="hub-state-sub">{{ t("hub.draining") }}</span>
      </template>
      <template v-else>
        {{ t("hub.supersedePending", { v: nextVersion ?? "?", time: deadlineLabel }) }}
      </template>
    </span>
    <button
      v-if="mode === 'pending'"
      class="btn btn-ghost btn-xs hub-state-toggle"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? t("hub.collapse") : t("hub.expand") }}
    </button>
    <p v-if="mode === 'pending' && expanded" class="hub-state-detail">{{ t("hub.supersedeDetail") }}</p>
  </div>
</template>
