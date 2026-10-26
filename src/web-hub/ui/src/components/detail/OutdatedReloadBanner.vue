<!--
  #65 outdated-reload · 会话详情页顶部提示条（预览 outdated-reload-preview.html §1–§4）。

  状态 → 形态（全部文案在 `outdated` i18n 命名空间；相 → tone/icon 的唯一真源是
  `@logic/outdatedReload.ts` 的 `orBannerView`）：
  - idle ∧ 落后 ∧ 未暂不      → warning 条：版本对 + 【重新加载】【暂不】（§1）
  - queued                    → info 条：排队说明（主会话忙 / fleet 忙两种文案）+【取消排队】（§2）
  - parked                    → info 条：已送达，等 N 个子 agent 结束（deferred reload park）+【取消排队】
  - sending / awaiting        → warning 条：spinner + 禁用按钮（§1 中间态 / §3 重试中）
  - failed                    → danger 条：原因 + 错误码 + 【重试】【关闭】（§3）
  - done                      → success toast「已重新加载到 X」，OR_TOAST_MS 后自消（§1）
  会话不再落后（版本到位——无论从哪条路径到达）⇒ 整条消失。【暂不】/【关闭】经
  manager.dismiss 记忆「hub 版本再变前不再提示」，卡片的 outdated 标记不受影响（§4）。

  无 OUTDATED_RELOAD_CTX provider（单测/独立挂载）⇒ 不渲染。
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { orBannerView } from "@logic/outdatedReload.js";
import { useI18n } from "../../composables/useI18n.js";
import { injectOutdatedReload } from "../../composables/useOutdatedReload.js";

const props = defineProps<{ agentKey: string }>();
const { t } = useI18n();
const manager = injectOutdatedReload();

const entry = computed(() => manager?.entryOf(props.agentKey) ?? { phase: "idle" as const });
const info = computed(() => manager?.infoOf(props.agentKey));
const hubVersion = computed(() => manager?.hubVersion.value);

/** 显隐：done 的 toast 优先；其余各相只在「仍落后 ∧ 未暂不」时显示。 */
const visible = computed(() => {
  if (manager === undefined) return false;
  if (entry.value.phase === "done") return true;
  return manager.outdatedOf(props.agentKey) && !manager.snoozedOf(props.agentKey);
});

const view = computed(() => orBannerView(entry.value));
const tone = computed(() => (view.value.tone === "warn" ? undefined : view.value.tone));
const role = computed(() => view.value.role);
const icon = computed(() => view.value.icon);
const spinning = computed(() => view.value.spinning);

/** queued/parked 文案分流与计数（N 实时读 manager，fleet 变化随帧签名 watch 重算）。 */
const mainBusy = computed(() => manager?.mainBusyOf(props.agentKey) ?? false);
const fleetN = computed(() => manager?.fleetActiveOf(props.agentKey) ?? 0);

/** 本地合成失败的人读原因（wire 失败直接用其 message；本地 precheck/超时的在这里）。 */
const failReason = computed(() => {
  const e = entry.value;
  if (e.message !== undefined) return e.message;
  switch (e.error) {
    case "E_OFFLINE":
      return t("outdated.errOffline");
    case "E_UNSUPPORTED":
      return t("outdated.errUnsupported");
    case "E_TIMEOUT":
      return t("outdated.errTimeout");
    case "E_QUEUE_TIMEOUT":
      return t("outdated.errQueueTimeout");
    default:
      return e.error ?? "";
  }
});

function onReload(): void {
  manager?.request(props.agentKey);
}
function onLater(): void {
  manager?.dismiss(props.agentKey);
}
function onCancelQueue(): void {
  manager?.cancelQueue(props.agentKey);
}
function onRetry(): void {
  manager?.request(props.agentKey);
}
function onClose(): void {
  manager?.dismiss(props.agentKey);
}
</script>

<template>
  <template v-if="visible">
    <div v-if="entry.phase === 'done'" class="or-toast" role="status">
      <AppIcon name="check" />
      <span
        >{{ t("outdated.donePre") }} <b class="num">{{ hubVersion }}</b></span
      >
    </div>
    <div v-else class="or-banner" :data-tone="tone" :role="role">
      <AppIcon :name="icon" :class="{ spin: spinning }" />
      <!-- idle / sending / awaiting：版本对 + 说明（§1） -->
      <span
        v-if="entry.phase === 'idle' || entry.phase === 'sending' || entry.phase === 'awaiting'"
        class="or-banner-text"
      >
        {{ t("outdated.bannerPre") }} <span class="mono num">{{ info?.pluginVersion ?? "?" }}</span>
        {{ t("outdated.bannerMid") }} <span class="mono num">{{ hubVersion }}</span
        >{{ t("outdated.bannerSuffix") }}
        <template v-if="entry.phase === 'awaiting'">{{ t("outdated.awaitingText") }}</template>
      </span>
      <!-- queued（§2）：主会话忙 / 仅 fleet 忙两种文案 -->
      <span v-else-if="entry.phase === 'queued'" class="or-banner-text">{{
        mainBusy ? t("outdated.queuedText") : t("outdated.queuedFleetText", { n: fleetN })
      }}</span>
      <!-- parked：已送达，deferred reload 在等 fleet（major 修复 2026-10-26） -->
      <span v-else-if="entry.phase === 'parked'" class="or-banner-text">{{
        t("outdated.parkedText", { n: fleetN })
      }}</span>
      <!-- failed（§3）：原因 + 错误码 -->
      <span v-else class="or-banner-text">
        {{ t("outdated.failedPre") }}{{ failReason }}（<span class="mono">{{ entry.error }}</span
        >）。
      </span>
      <span class="or-banner-actions">
        <template v-if="entry.phase === 'queued' || entry.phase === 'parked'">
          <button class="btn" type="button" @click="onCancelQueue">{{ t("outdated.cancelQueue") }}</button>
        </template>
        <template v-else-if="entry.phase === 'failed'">
          <button class="btn btn-primary" type="button" @click="onRetry">{{ t("outdated.retry") }}</button>
          <button class="btn" type="button" @click="onClose">{{ t("outdated.close") }}</button>
        </template>
        <template v-else>
          <button class="btn btn-primary" type="button" :disabled="entry.phase !== 'idle'" @click="onReload">
            {{ entry.phase === "idle" ? t("outdated.reload") : t("outdated.reloading") }}
          </button>
          <button class="btn" type="button" :disabled="entry.phase !== 'idle'" @click="onLater">
            {{ t("outdated.later") }}
          </button>
        </template>
      </span>
    </div>
  </template>
</template>
