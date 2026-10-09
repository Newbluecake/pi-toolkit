<!--
  A user message bubble (ui-design.md §5.4: right-aligned, teal-soft bubble, `pre-wrap`).

  C5 (control-plan.md v2.1 §7.7): web-sent user messages get a small `web` badge, matched
  best-effort off the agent's ctl ledger (`CONTROL_VIEW.isWebMessage` — timestamp proximity to
  a `started`/`consumed` ledger entry; any doubt ⇒ no badge). The inject is optional: mounted
  outside a detail pane (isolated tests) nothing changes.

  PV6 (web-hub-preview plan v3 §4.6): the bubble's plain text renders through `PathText`, so
  absolute paths a user pastes become clickable previews whenever a preview scope is live; with
  no ctx/scope the rendered DOM is byte-identical to the bare text node it replaces.
  2026-10-09 「输入框输入的内容也需要像 pi 一样增加一个头像」: a decorative user avatar mirrors
  the assistant's — right column, same 28px chip, only ≥481px (same breakpoint as `.avatar`).
  Same day 「web 和时间放在同一行」: badges + time share one `.msg-foot` row under the bubble.
-->
<script setup lang="ts">
import { computed, inject } from "vue";
import { formatDateTime } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_VIEW } from "../control/controlContext.js";
import PathText from "../preview/PathText.vue";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  readonly text: string;
  readonly truncated: boolean;
  readonly timestamp: number | undefined;
}>();
const i18n = useI18n();
const { t } = i18n;
const timeLabel = computed(() =>
  props.timestamp === undefined ? "" : formatDateTime(props.timestamp, i18n.lang === "zh" ? "zh-CN" : "en-US"),
);

const view = inject(CONTROL_VIEW, null);
const fromWeb = computed(() => view?.isWebMessage(props.timestamp) === true);
</script>

<template>
  <div class="msg-user tx-item">
    <div class="bubble"><PathText :text="text" /></div>
    <span class="avatar avatar-user" aria-hidden="true"><AppIcon name="user" class="icon" /></span>
    <span v-if="fromWeb || truncated || timeLabel" class="msg-foot">
      <span v-if="fromWeb" class="badge badge-web" translate="no">{{ t("control.badgeWeb") }}</span>
      <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
      <span v-if="timeLabel" class="msg-time" translate="no">{{ timeLabel }}</span>
    </span>
  </div>
</template>
