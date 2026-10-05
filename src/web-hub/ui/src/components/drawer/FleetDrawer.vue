<script lang="ts">
/**
 * fleet 抽屉(fleet-drawer plan v2 §6 — F6)的模式/开合状态组合式函数,放在本文件的普通
 * `<script>` 块里导出,供 `AgentDetail.vue`(抽屉状态的拥有者)使用 —— 状态提升到
 * AgentDetail 是因为 `.detail[data-drawer=…][data-drawer-open]` 这两个 CSS 钩子要挂在
 * `<main>` 上,而 FleetSummaryBar(在 DetailBody 里)也要读 `open` 做 `aria-expanded`。
 * localStorage 只允许出现在本文件(source-scan 白名单 `drawer/FleetDrawer\.vue`,§8.3),
 * 所以 docked 开合持久化(`webhub.fleetDrawer.open`,默认 "1")也必须物理上写在这里。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useMedia, type MediaWindow } from "../../composables/useMedia.js";
import type { FleetDrawerMode } from "../../contracts.js";

// 普通 <script> 与 <script setup> 合并为同一模块作用域:下面的 setup 块直接用这里的
// computed/ref/watch,不再重复 import。

export interface FleetDrawerModeHandle {
  readonly mode: ComputedRef<FleetDrawerMode>;
}

/** §6.2:≥1280px docked;≤767px fullscreen;中间 768–1279px 为 overlay(用户已定)。 */
export function useFleetDrawerMode(win: MediaWindow): FleetDrawerModeHandle {
  const wide = useMedia(win, "(min-width: 1280px)");
  const phone = useMedia(win, "(max-width: 767px)");
  return {
    mode: computed<FleetDrawerMode>(() =>
      wide.matches.value ? "docked" : phone.matches.value ? "fullscreen" : "overlay",
    ),
  };
}

export interface FleetDrawerOpenHandle {
  readonly open: Ref<boolean>;
  toggle(): void;
  close(): void;
  openDrawer(): void;
}

const DRAWER_OPEN_KEY = "webhub.fleetDrawer.open";

function readPersistedOpen(): boolean {
  try {
    return window.localStorage.getItem(DRAWER_OPEN_KEY) !== "0"; // 默认 "1"
  } catch {
    return true; // storage 被禁用:退回默认,绝不抛
  }
}

function persistOpen(open: boolean): void {
  try {
    window.localStorage.setItem(DRAWER_OPEN_KEY, open ? "1" : "0");
  } catch {
    // storage 被禁用:开合退化为纯会话内状态
  }
}

/**
 * §6.2 的行为列:docked 的开合持久化(默认开);overlay/fullscreen 每次挂载都是关闭状态、
 * 不持久化。模式切换(窗口缩放跨过断点)按「新模式的初始语义」重置:进 docked 读持久化值,
 * 进 overlay/fullscreen 关闭 —— 避免覆盖式抽屉在缩小窗口后保持打开却无焦点管理的状态残留。
 */
export function useFleetDrawerOpen(mode: Readonly<Ref<FleetDrawerMode>>): FleetDrawerOpenHandle {
  const open = ref(mode.value === "docked" ? readPersistedOpen() : false);
  watch(mode, (m) => {
    open.value = m === "docked" ? readPersistedOpen() : false;
  });
  watch(open, (v) => {
    if (mode.value === "docked") persistOpen(v);
  });
  return {
    open,
    toggle(): void {
      open.value = !open.value;
    },
    close(): void {
      open.value = false;
    },
    openDrawer(): void {
      open.value = true;
    },
  };
}
</script>

<script setup lang="ts">
/**
 * FleetDrawer —— 抽屉本体,§6.4 键盘/指针/焦点契约的唯一 owner:
 *
 * 1. 只有本组件注册文档级监听,且仅在 `mode !== "docked" && open` 时(watch + onCleanup
 *    动态注册/移除,卸载时随之移除 —— 不调 transport,run 订阅只归 useHub 管,§6.4 #7):
 *    `document` 的 **bubble** 阶段 keydown,overlay 模式下再加 pointerdown。
 * 2. 事件顺序:元素级处理器(如 FleetActions 的 Esc 解除武装会 stopPropagation)先执行,
 *    抽屉收不到是期望行为;抽屉处理后 preventDefault + stopPropagation,window 上
 *    DashboardView 的 defaultPrevented 守卫是双保险。
 * 3. Esc 规则链:非 Escape / isComposing / defaultPrevented / 目标是 input|textarea|select
 *    ⇒ 不处理(与 DashboardView.vue 的判定一致)。
 * 4. pointerdown(仅 overlay):落在抽屉内部或 `[aria-controls="fleet-drawer"]`(摘要行按钮)
 *    上 ⇒ 忽略,避免「先关闭再被重新打开」;否则关闭。fullscreen 占满全屏,没有「外部」。
 * 5. 焦点:非 docked 打开时移到抽屉的关闭按钮;关闭时还给摘要行按钮,不在 DOM 则还给主区
 *    `#transcript`。docked 开合不动焦点。
 *
 * 内容区:选中 run 时是 RunHeader + RunTranscript(各模式都只显示其一,fullscreen 的
 * 「← 子 agent 列表」返回键在 RunHeader 上,所有模式都可用来回到树);未选中时是树
 * (FleetTree + 「另有 N 个」)。选中/退选经 `FLEET_SELECT`(provide 给 FleetTree)和
 * RunHeader 的 back —— 都汇到 `HubHandle.selectRun`,组件从不直连 transport。
 */
import { inject, nextTick, onBeforeUnmount, provide } from "vue";
import type { FleetRowWire } from "@protocol/messages.js";
import type { FleetDrawerEmits, FleetDrawerProps } from "../../contracts.js";
import "../../styles/drawer.css";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import AppIcon from "../../icons/AppIcon.vue";
import FleetTree from "../fleet/FleetTree.vue";
import { buildFleetTree, orphanRunIds, runTranscriptAvailable, FLEET_SELECT } from "../fleet/summary.js";
import RunHeader from "./RunHeader.vue";
import RunTranscript from "./RunTranscript.vue";

const props = defineProps<FleetDrawerProps>();
const emit = defineEmits<FleetDrawerEmits>();
const { t } = useI18n();

const rootEl = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// 树视图数据 + run 选择接缝(FLEET_SELECT,§6.3)
// ---------------------------------------------------------------------------
const rows = computed(() => props.agent.fleet as unknown as readonly FleetRowWire[]);
const treeNodes = computed(() => buildFleetTree(rows.value));
const orphans = computed(() => orphanRunIds(rows.value));
const selectedRunId = computed(() => props.agent.runSel ?? null);

const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);
const canOpen = computed(() => runTranscriptAvailable(props.agent.card, env?.authMode) && hub?.selectRun !== undefined);
provide(FLEET_SELECT, {
  canOpen,
  select(runId: string): void {
    if (!canOpen.value) return;
    hub?.selectRun?.(props.agent.key, runId);
  },
});

function onClose(): void {
  emit("close");
}

/** 「← 子 agent 列表」:退选 run(订阅由 useHub 拆除),抽屉保持打开、回到树视图。 */
function onBackToTree(): void {
  hub?.selectRun?.(props.agent.key, null);
}

// ---------------------------------------------------------------------------
// §6.4 键盘/指针契约(唯一 owner)
// ---------------------------------------------------------------------------
function onKey(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" || ev.isComposing || ev.defaultPrevented) return;
  const target = ev.target as HTMLElement | null;
  if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
  ev.preventDefault();
  ev.stopPropagation();
  onClose();
}

function onPointer(ev: PointerEvent): void {
  const target = ev.target as Node | null;
  if (target === null) return;
  if (rootEl.value?.contains(target) === true) return;
  if (target instanceof Element && target.closest('[aria-controls="fleet-drawer"]') !== null) return;
  onClose();
}

watch(
  () => [props.mode, props.open] as const,
  ([mode, open], _prev, onCleanup) => {
    if (mode === "docked" || !open) return;
    document.addEventListener("keydown", onKey);
    if (mode === "overlay") document.addEventListener("pointerdown", onPointer);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    });
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  // watch 的 onCleanup 在卸载时本就会跑;这里再兜底一次(幂等),钉住 §6.4 #7 的
  // 「卸载后 document 上没有残留监听」(U6 用 removeEventListener spy 断言)。
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("pointerdown", onPointer);
});

// ---------------------------------------------------------------------------
// §6.4 #6 焦点迁移(仅非 docked;docked 开合不动焦点)
// ---------------------------------------------------------------------------
watch(
  () => props.open,
  async (open, wasOpen) => {
    if (props.mode === "docked" || open === wasOpen) return;
    if (open) {
      await nextTick();
      rootEl.value?.querySelector<HTMLElement>(".drawer-close")?.focus();
      return;
    }
    const toggle = document.querySelector<HTMLElement>('[aria-controls="fleet-drawer"]');
    if (toggle !== null && document.contains(toggle)) {
      toggle.focus();
      return;
    }
    document.getElementById("transcript")?.focus();
  },
);
</script>

<template>
  <aside
    id="fleet-drawer"
    ref="rootEl"
    class="fleet-drawer"
    :data-mode="mode"
    :data-open="open || undefined"
    :role="mode === 'docked' ? undefined : 'dialog'"
    :aria-modal="mode === 'fullscreen' ? true : undefined"
    :aria-label="t('fleet.panelTitle')"
  >
    <template v-if="selectedRunId !== null">
      <RunHeader :agent="agent" :mode="mode" @back="onBackToTree" @close="onClose" />
      <RunTranscript :key="selectedRunId" :agent="agent" :now="now" />
    </template>
    <template v-else>
      <div class="drawer-head">
        <span class="drawer-title">{{ t("fleet.panelTitle") }}</span>
        <button
          class="btn btn-ghost btn-icon drawer-close"
          type="button"
          :aria-label="t('drawer.close')"
          @click="onClose"
        >
          <AppIcon name="x" class="icon-sm" />
        </button>
      </div>
      <div class="tree-scroll">
        <FleetTree :nodes="treeNodes" :now="now" :orphans="orphans" :omitted="agent.fleetOmitted" />
      </div>
    </template>
  </aside>
</template>
