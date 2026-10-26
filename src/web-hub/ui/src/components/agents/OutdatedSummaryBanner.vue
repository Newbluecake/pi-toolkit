<!--
  #65 outdated-reload · 会话列表（仪表盘）汇总条（预览 outdated-reload-preview.html §6）。

  ≥2 个落后会话时出现（info 态）：「N 个会话的插件版本落后于 hub X」+【全部重新加载】
  【查看】。【全部重新加载】对每个落后会话走 manager.request（忙的自动排队、空闲后自动
  续上），逐个显示进度行；全部到位 → 短暂 toast；有失败 → 失败行留在列表里（原因+错误
  码），可再次点【全部重新加载】（request 幂等，failed 相自动重试）。【查看】跳到列表
  路由 `#/`（窄屏单视图下从详情页回到卡片列表；宽屏本就在列表旁，hash 不变是无害的）。

  详情页的单会话条是 `detail/OutdatedReloadBanner.vue`；「需更新」chip 在 AgentCard。
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { injectOutdatedReload } from "../../composables/useOutdatedReload.js";
import { HUB_CTX } from "../control/controlContext.js";
import { homeFromAgents, toAgentCardView } from "./agentCardModel.js";
import type { OrEntry } from "@logic/outdatedReload.js";

const { t } = useI18n();
const manager = injectOutdatedReload();
const hub = inject(HUB_CTX, null);

const list = computed(() => manager?.outdatedList.value ?? []);
const hubVersion = computed(() => manager?.hubVersion.value);

/** 本次「全部重新加载」涉及的 key（进度行）；空 ⇒ 未在跑/已收官。 */
const runKeys = ref<readonly string[]>([]);
/** 全部到位后的 toast 短暂停留。 */
const doneToast = ref(false);
let toastTimer: number | undefined;

function entryOf(key: string): OrEntry {
  return manager?.entryOf(key) ?? { phase: "idle" };
}

const running = computed(() =>
  runKeys.value.some((k) => {
    const p = entryOf(k).phase;
    return p === "queued" || p === "sending" || p === "awaiting" || p === "parked";
  }),
);

const visible = computed(
  () => manager !== undefined && (list.value.length >= 2 || runKeys.value.length > 0 || doneToast.value),
);

function labelOf(key: string): string {
  const agent = hub?.state.value.agents.get(key);
  if (agent === undefined || hub === null) return key;
  const home = homeFromAgents(hub.state.value.agents.values());
  return toAgentCardView(agent, t, home).shortCwd;
}

function onReloadAll(): void {
  if (manager === undefined) return;
  window.clearTimeout(toastTimer);
  doneToast.value = false;
  runKeys.value = list.value.map((r) => r.key);
  manager.reloadAll();
}

function onView(): void {
  window.location.hash = "#/";
}

onBeforeUnmount(() => window.clearTimeout(toastTimer));

/** 全部到位 ⇒ toast 4s 后清场；有失败 ⇒ 行保留（banner 因仍有落后会话而继续显示）。 */
watch(running, (isRunning, wasRunning) => {
  if (isRunning || !wasRunning || runKeys.value.length === 0) return;
  if (runKeys.value.every((k) => entryOf(k).phase === "done")) {
    doneToast.value = true;
    toastTimer = window.setTimeout(() => {
      doneToast.value = false;
      runKeys.value = [];
    }, 4_000);
  }
});
</script>

<template>
  <template v-if="visible">
    <div v-if="doneToast" class="or-toast or-summary-toast" role="status">
      <AppIcon name="check" />
      <span
        >{{ t("outdated.summaryDonePre") }}{{ runKeys.length }}{{ t("outdated.summaryDoneMid")
        }}<b class="num">{{ hubVersion }}</b
        >{{ t("outdated.summaryDoneSuffix") }}</span
      >
    </div>
    <div v-else class="or-banner or-summary" data-tone="info" role="status">
      <AppIcon name="info" />
      <span class="or-banner-text">
        <b class="num">{{ list.length }}</b
        >{{ t("outdated.summaryMid") }} <span class="mono num">{{ hubVersion }}</span
        >{{ t("outdated.summarySuffix") }}
      </span>
      <span class="or-banner-actions">
        <button class="btn btn-primary" type="button" :disabled="running" @click="onReloadAll">
          {{ t("outdated.reloadAll") }}
        </button>
        <button class="btn" type="button" @click="onView">{{ t("outdated.view") }}</button>
      </span>
    </div>
    <ul v-if="runKeys.length > 0 && !doneToast" class="or-progress">
      <li v-for="key in runKeys" :key="key">
        <AppIcon v-if="entryOf(key).phase === 'done'" name="check" class="icon-sm or-ok" />
        <AppIcon v-else-if="entryOf(key).phase === 'failed'" name="alert" class="icon-sm or-bad" />
        <AppIcon v-else-if="entryOf(key).phase === 'idle'" name="info" class="icon-sm or-wait" />
        <AppIcon v-else name="loader" class="icon-sm spin" />
        <span class="or-row-name" translate="no">{{ labelOf(key) }}</span>
        <span v-if="entryOf(key).phase === 'queued'" class="or-wait">{{ t("outdated.rowQueued") }}</span>
        <span v-else-if="entryOf(key).phase === 'parked'" class="or-wait">{{
          t("outdated.rowParked", { n: manager?.fleetActiveOf(key) ?? 0 })
        }}</span>
        <span v-else-if="entryOf(key).phase === 'sending'">{{ t("outdated.rowSending") }}</span>
        <span v-else-if="entryOf(key).phase === 'awaiting'">{{ t("outdated.rowAwaiting") }}</span>
        <span v-else-if="entryOf(key).phase === 'done'" class="or-ok">{{ t("outdated.rowDone") }}</span>
        <span v-else-if="entryOf(key).phase === 'failed'" class="or-bad">
          {{ t("outdated.rowFailedPre") }}<span class="mono">{{ entryOf(key).error }}</span>
        </span>
        <span v-else class="or-wait">…</span>
      </li>
    </ul>
  </template>
</template>
