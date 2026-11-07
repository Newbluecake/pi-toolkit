<!--
  #23 P-A（D9）：目标消失后的「重新加载结果」行。挂在 DashboardView 的「已删除」「未连接」
  空态 #actions 插槽里（宽屏/窄屏共 4 处，紧邻「返回列表」），只在 entry 为 failed 或 done
  时渲染——协调器的 entry 按 key 保留（不随卡片消失清除），restore 导航照常把查看者带到
  successor（D8），这里只如实保留旧 key 的结果。原因文案统一经 `orFailReason`（唯一来源）。

  无 OUTDATED_RELOAD_CTX provider（单测/独立挂载）⇒ 不渲染。

  样式说明：SFC 内联 style 块被 source-scan 禁止、styles/outdated-reload.css 不在 #23 P-A 文件
  域——这里用对象式 `:style` 绑定（值以 `{` 起头，source-scan 白名单形状；经 CSSOM 写入，
  不受 CSP `style-src 'self'` 限制——与 DashboardView 的 layoutStyle 同款），颜色全部引
  tokens.css 变量（深色自动跟随）。P-C 文档收口时可整体迁回 outdated-reload.css。
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { orFailReason } from "@logic/outdatedReload.js";
import { useI18n } from "../../composables/useI18n.js";
import { injectOutdatedReload } from "../../composables/useOutdatedReload.js";

const props = defineProps<{ agentKey: string }>();
const { t } = useI18n();
const manager = injectOutdatedReload();

const entry = computed(() => manager?.entryOf(props.agentKey) ?? { phase: "idle" as const });
const visible = computed(
  () =>
    manager !== undefined && props.agentKey !== "" && (entry.value.phase === "failed" || entry.value.phase === "done"),
);
const failed = computed(() => entry.value.phase === "failed");
const hubVersion = computed(() => manager?.hubVersion.value);
/** orFailReason：有 wire message 用 raw，已知错误码映射 i18n（D9 唯一来源）。 */
const reason = computed(() => {
  const r = orFailReason(entry.value);
  return "key" in r ? t(r.key) : r.raw;
});

const RESULT_BASE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--sp-1)",
  margin: "0",
  maxWidth: "48ch",
  fontSize: "var(--fs-sm)",
  lineHeight: "var(--lh-snug)",
  textAlign: "left",
} as const;
const RESULT_FAILED = { ...RESULT_BASE, color: "var(--c-danger)" } as const;
const RESULT_DONE = { ...RESULT_BASE, color: "var(--c-text-2)" } as const;
</script>

<template>
  <p
    v-if="visible"
    class="or-result"
    :data-or="failed ? 'failed' : 'done'"
    :style="failed ? RESULT_FAILED : RESULT_DONE"
    :role="failed ? 'alert' : 'status'"
  >
    <AppIcon :name="failed ? 'alert' : 'check'" class="icon-sm" />
    <span v-if="failed">{{ t("outdated.resultPre") }}{{ reason }}</span>
    <span v-else
      >{{ t("outdated.donePre") }}<b class="num">{{ hubVersion }}</b></span
    >
  </p>
</template>
