<!--
  Collapsible session details (ui-design.md §5.2, §12, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/detail/**`): a one-line, tap-to-expand `<details>` summary (cwd, model
  + thinking level, session id prefix) plus a `dl.kv` of full copyable values when expanded.
  No hover tooltips (ui-design §6.3) — everything reachable is either always visible in the
  summary or one tap away in the `kv` list.
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { SessionInfoProps } from "../../contracts.js";
import CopyButton from "./CopyButton.vue";

const props = defineProps<SessionInfoProps>();
const { t } = useI18n();

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p !== "");
  return parts.length === 0 ? "/" : parts.slice(-2).join("/");
}

const cwdFull = computed(() => props.session?.cwd ?? props.card?.cwd ?? "");
const modelLine = computed(() => {
  const model = props.session?.model;
  if (!model) return "";
  const level = props.session?.thinkingLevel;
  return level ? `${model.provider}/${model.id} · ${level}` : `${model.provider}/${model.id}`;
});
const sessionIdShort = computed(() => (props.session?.sessionId ?? "").slice(0, 8));
const processLine = computed(() => {
  const kind = (props.card?.kind ?? props.session?.mode ?? "").toUpperCase();
  const parts = [
    kind || undefined,
    props.card ? `pid ${props.card.pid}` : undefined,
    props.card ? `plugin ${props.card.pluginVersion}` : undefined,
  ];
  return parts.filter((p): p is string => p !== undefined).join(" · ");
});
</script>

<template>
  <details class="session-info">
    <summary class="session-sum" :aria-label="t('detail.sessionDetailsAria')">
      <span
        ><AppIcon name="folder" class="icon-sm" /><span class="trunc" translate="no">{{
          shortCwd(cwdFull)
        }}</span></span
      >
      <span v-if="modelLine" class="grow"
        ><AppIcon name="cpu" class="icon-sm" /><span class="trunc" translate="no">{{ modelLine }}</span></span
      >
      <span v-if="sessionIdShort" class="hide-sm"
        ><AppIcon name="hash" class="icon-sm" /><span class="trunc" translate="no">{{ sessionIdShort }}</span></span
      >
      <AppIcon name="chev-right" class="icon-sm chev" />
    </summary>
    <dl class="kv">
      <div>
        <dt>{{ t("detail.kvCwd") }}</dt>
        <dd translate="no">{{ cwdFull }}</dd>
        <CopyButton :value="cwdFull" :label="t('detail.copyCwd')" />
      </div>
      <div v-if="session?.sessionId">
        <dt>{{ t("detail.kvSession") }}</dt>
        <dd translate="no">{{ session.sessionId }}</dd>
        <CopyButton :value="session.sessionId" :label="t('detail.copySession')" />
      </div>
      <div v-if="modelLine">
        <dt>{{ t("detail.kvModel") }}</dt>
        <dd translate="no">{{ modelLine }}</dd>
        <span></span>
      </div>
      <div v-if="processLine">
        <dt>{{ t("detail.kvProcess") }}</dt>
        <dd translate="no">{{ processLine }}</dd>
        <span></span>
      </div>
    </dl>
  </details>
</template>
