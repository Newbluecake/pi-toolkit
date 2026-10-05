<!--
  抽屉里被选中 run 的 transcript(fleet-drawer plan v2 §6.6 — F6)。渲染内核复用主会话的
  `Transcript.vue`(F5 已保证 `RunTxState.items` 与主会话同构,直接喂 `buildTxEntries` 的
  `TranscriptSource` 投影;`anchorId="run-transcript"` 保证与主区 `#transcript` 并存时 id
  不重复,U7)。本组件自己持有 `following`/`newCount`(与主区互不干扰,U7),带一个迷你
  「↓ 最新」按钮。

  页脚状态机(§6.5/§6.6,优先级从上到下):
  - `history === "error"`:§3.6 的 reason 文案 + 「重试」按钮(⇒ `selectRun` 重选同一 run,
     reducer 的 `run_select` 重置语义就是错误态的手动重试路径)。
  - `pendingSince !== undefined && history === "loaded"`:「重新连接中」角标(hello 换
     clientId 后的重订阅期间保留已有内容,§6.5)。
  - `terminal`:终态 chip(已结束 · status)。已收到的内容不清空(§3.6)。
  - `live === false && !terminal`(watching:false,tap 名额满):降级页脚 ——
    `fleetActivity(lastRow)`(与 FleetTree 的行内摘要同一个函数,U11)+ 降级原因。
  - `reason` 在 loaded 态非空:翻页遇到 deny 类拒绝(§3.6),「加载更早」已被 F5 置
    hasMore=false 禁用,这里只显示提示。
-->
<script setup lang="ts">
import { computed, inject, provide, ref } from "vue";
import type { RunTranscriptProps, TranscriptSource } from "../../contracts.js";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_VIEW, HUB_CTX, type ControlView } from "../control/controlContext.js";
import AppIcon from "../../icons/AppIcon.vue";
import Transcript from "../transcript/Transcript.vue";
import { fleetActivity } from "../fleet/summary.js";

const props = defineProps<RunTranscriptProps>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);

// §6.6: 覆盖 AgentDetail 的 CONTROL_VIEW,使 TxUser 的 web 徽标在子 agent 会话里不出现
// (子会话没有 ctl 账本,匹配只会误报)。CONTROL_VIEW 的 InjectionKey 类型不允许 null
// (controlContext.ts 是冻结面,不在本包文件域),这里以显式 cast 提供 null —— 所有消费点
// (TxUser 等)都是 `inject(CONTROL_VIEW, null)` + 可选链,null 与缺省行为逐字节一致。
provide(CONTROL_VIEW, null as unknown as ControlView);

const tx = computed(() => props.agent.runTx ?? null);

const txSource = computed<TranscriptSource | null>(() => {
  const cur = tx.value;
  if (cur === null) return null;
  return {
    key: cur.runId,
    items: cur.items,
    streaming: cur.streaming,
    tools: cur.tools,
    history: cur.history,
    ...(cur.historyError !== undefined ? { historyError: cur.historyError } : {}),
    hasMore: cur.hasMore,
    paging: cur.paging,
  };
});

// --- 自有的 follow/new-count(与主会话的实例互不影响,U7)------------------------
const following = ref(true);
const newCount = ref(0);
function onUpdateFollowing(value: boolean): void {
  following.value = value;
  if (value) newCount.value = 0;
}
function onNewCount(n: number): void {
  newCount.value = n;
}
function jumpToLatest(): void {
  onUpdateFollowing(true);
}

// --- 动作 ---------------------------------------------------------------------
/** 「加载更早」⇒ useHub.pageRun(F5 已做 loaded/hasMore/paging 守卫与 deny 类禁用)。 */
function onLoadOlder(): void {
  hub?.pageRun?.(props.agent.key);
}
/** 错误态重试(§6.5):重选同一 run —— reducer 的 run_select 重置 runTx,useHub 重新订阅。 */
function onRetry(): void {
  const cur = tx.value;
  if (cur === null) return;
  hub?.selectRun?.(props.agent.key, cur.runId);
}

// --- 页脚状态 -----------------------------------------------------------------
const reasonText = computed(() => {
  const reason = tx.value?.reason;
  if (typeof reason !== "string" || reason === "") return "";
  const key = `drawer.reason.${reason}`;
  const text = t(key);
  return text === key ? "" : text; // 未知 reason:不显示生 key,退回错误码行
});
const reconnecting = computed(() => {
  const cur = tx.value;
  return cur !== null && cur.pendingSince !== undefined && cur.history === "loaded";
});
const degraded = computed(() => {
  const cur = tx.value;
  return cur !== null && cur.history === "loaded" && !cur.terminal && cur.live === false;
});
const degradedActivity = computed(() => {
  const row = tx.value?.lastRow;
  return row === undefined ? "" : fleetActivity(row);
});
const terminalChip = computed(() => {
  const cur = tx.value;
  return cur !== null && cur.terminal && cur.history === "loaded";
});
/** 页脚只在有内容时渲染(避免一条空边框):错误态 / 重连角标 / 终态 chip / 降级 / 翻页拒绝提示。 */
const hasFooter = computed(
  () =>
    tx.value !== null &&
    (tx.value.history === "error" ||
      reconnecting.value ||
      terminalChip.value ||
      degraded.value ||
      reasonText.value !== ""),
);
</script>

<template>
  <div class="run-tx">
    <Transcript
      v-if="txSource !== null"
      :agent="txSource"
      :following="following"
      :narrow="true"
      anchor-id="run-transcript"
      :aria-label="t('drawer.runTranscriptAria')"
      @load-older="onLoadOlder"
      @update:following="onUpdateFollowing"
      @new-count="onNewCount"
    />
    <div v-else class="tx-status" aria-busy="true">{{ t("transcript.loadingHistory") }}</div>

    <button v-if="!following && txSource !== null" class="btn run-tx-latest" type="button" @click="jumpToLatest">
      <AppIcon name="arrow-down" />{{ t("detail.latest")
      }}<template v-if="newCount > 0"> · {{ t("detail.newCount", { n: newCount }) }}</template>
    </button>

    <footer v-if="hasFooter && tx !== null" class="run-tx-foot">
      <template v-if="tx.history === 'error'">
        <span v-if="reasonText" class="run-tx-note">{{ reasonText }}</span>
        <button class="btn btn-ghost btn-xs run-tx-retry" type="button" @click="onRetry">
          <AppIcon name="refresh" class="icon-sm" />{{ t("drawer.retry") }}
        </button>
      </template>
      <template v-else>
        <span v-if="reconnecting" class="run-tx-badge" role="status">{{ t("drawer.reconnecting") }}</span>
        <span v-if="terminalChip" class="chip chip-terminal">{{
          t("drawer.terminalStatus", { status: tx.status })
        }}</span>
        <template v-else-if="degraded">
          <span class="run-tx-note">{{ t("drawer.watchingOff") }}</span>
          <span v-if="degradedActivity" class="run-tx-activity" translate="no">{{ degradedActivity }}</span>
        </template>
        <span v-if="reasonText" class="run-tx-note">{{ reasonText }}</span>
      </template>
    </footer>
  </div>
</template>
