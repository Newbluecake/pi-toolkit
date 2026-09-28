<!--
  Persistent control risk notice (control-plan.md v2.1 §7.4/§7.6, ui-design §10
  `persistent: true` — C5): always present while control is on, COLLAPSIBLE to a one-line
  summary (native `<details>`) but NEVER closable (no dismiss control — the visual harness
  asserts this). Copy variant (§7.6): token mode ⇒ local; password over plaintext HTTP ⇒
  plainHttp; password behind an HTTPS-terminating proxy ⇒ https. The expanded state is shared
  (`CONTROL_ENV.noticeExpanded`) so the TopBar Control chip opens the same notice (§7.4).
-->
<script setup lang="ts">
import { computed, getCurrentInstance, inject, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import type { ControlNoticeProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";
import { CONTROL_ENV } from "./controlContext.js";

const props = defineProps<ControlNoticeProps>();
const { t } = useI18n();

const env = inject(CONTROL_ENV, null);

// Vue Boolean-casts absent optional props to `false`, so an explicit `:plaintext="false"` and
// "prop not passed" are indistinguishable via `props` alone — `vnode.props` key presence is the
// tri-state escape hatch (env fills in only when the caller said nothing).
const vnodeProps = getCurrentInstance()?.vnode.props ?? {};

const variant = computed<"plainHttp" | "https" | "local">(() => {
  const mode = props.mode ?? env?.authMode ?? "token";
  const plaintext = "plaintext" in vnodeProps ? props.plaintext === true : (env?.plaintext ?? false);
  if (mode === "password") return plaintext ? "plainHttp" : "https";
  return "local";
});

const bodyKey = computed(
  () =>
    ({ plainHttp: "control.noticePlainHttp", https: "control.noticeHttps", local: "control.noticeLocal" })[
      variant.value
    ],
);

const localOpen = ref(false);
const open = computed({
  get: () => env?.noticeExpanded.value ?? localOpen.value,
  set: (v: boolean) => {
    if (env) env.noticeExpanded.value = v;
    else localOpen.value = v;
  },
});

function onToggle(ev: Event): void {
  open.value = (ev.target as HTMLDetailsElement).open;
}
</script>

<template>
  <details class="control-notice" :open="open" @toggle="onToggle">
    <summary>
      <AppIcon name="alert" class="icon-sm" />
      <span class="notice-title">{{ t("control.noticeTitle") }}</span>
      <span class="notice-toggle">{{ open ? t("control.noticeCollapse") : t("control.noticeExpand") }}</span>
    </summary>
    <p class="notice-body">{{ t(bodyKey) }}</p>
  </details>
</template>
