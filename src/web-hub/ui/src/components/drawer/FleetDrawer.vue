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
/** #41/#42: production passes an explicit panel and effective mode; undefined panel
 * preserves legacy combined callers. Keyboard/outside/focus remain owned here, while
 * open intent belongs to AgentDetail's useActivityRail. */
import { inject, nextTick, onBeforeUnmount, onMounted, provide } from "vue";
import type { FleetRowWire } from "@protocol/messages.js";
import type { FleetDrawerEmits, FleetDrawerProps } from "../../contracts.js";
import "../../styles/drawer.css";
import "../../styles/load.css";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import AppIcon from "../../icons/AppIcon.vue";
import FleetTree from "../fleet/FleetTree.vue";
import FleetBashJobs from "../fleet/FleetBashJobs.vue";
import FleetArchived from "../fleet/FleetArchived.vue";
import { bashJobsOf, statusToken } from "../detail/bashJobsView.js";
import { archivedOf, archiveSetOf, partitionArchived } from "../fleet/archiveView.js";
import {
  computeFillBudget,
  fixedAgentRowCount,
  topTerminalRowCount,
  type FillBudget,
  type FillCounts,
} from "../fleet/fillBudget.js";
import { observeResize } from "../../composables/useSharedResize.js";
import { bannerView } from "@logic/load.js";
import { buildFleetTree, orphanRunIds, runTranscriptAvailable, FLEET_ARCHIVE, FLEET_SELECT } from "../fleet/summary.js";
import RunHeader from "./RunHeader.vue";
import RunTranscript from "./RunTranscript.vue";

const props = defineProps<FleetDrawerProps>();
const emit = defineEmits<FleetDrawerEmits>();
// Capture before stopped run-open clicks, and include native keyboard activation of
// buttons and summaries. Passive clicks and data-driven fold changes are not intent.
function onDrawerClick(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest("button, summary, a, input, select, textarea")) {
    emit("intent");
  }
}
const { t } = useI18n();

const rootEl = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// web-hub archive plan (docs/dev/web-hub/archive-report.md): archived runs leave the tree
// (they land in the bottom「已归档 N」fold), bash rows partition inside FleetBashJobs. The undo
// toast lives HERE (both halves share it): ~4s window,「撤销」sends the reverse op.
// ---------------------------------------------------------------------------
const archiveWire = computed(() => archivedOf(props.agent));
const runArchive = computed(() => archiveSetOf(archiveWire.value, "run"));
const bashArchive = computed(() => archiveSetOf(archiveWire.value, "bash"));
const liveRows = computed(() => partitionArchived(rows.value, runArchive.value).live);
const archivedRows = computed(() => partitionArchived(rows.value, runArchive.value).archivedRows);

const hub = inject(HUB_CTX, null);
/** One toast for BOTH archive halves: a single-row archive carries an undo affordance, the bulk
 *  `archive_omitted` click carries a one-shot outcome note (2026-10-28 rework: previously its
 *  promise was dropped on the floor, so success / nothing-to-do / failure all looked identical —
 *  i.e. like a dead button). */
const archToast = ref<{
  text: string;
  kind: "run" | "bash";
  id: string;
  undo: boolean;
  /** Diagnostics only (the error code on a failed bulk archive) — surfaced via `title`. */
  title?: string;
} | null>(null);
let archToastTimer: ReturnType<typeof setTimeout> | undefined;
const TOAST_MS = 4000;
const TOAST_ERR_MS = 8000;
function showArchToast(
  text: string,
  opts: { kind?: "run" | "bash"; id?: string; undo?: boolean; title?: string; ms?: number } = {},
): void {
  archToast.value = {
    text,
    kind: opts.kind ?? "run",
    id: opts.id ?? "",
    undo: opts.undo === true,
    ...(opts.title === undefined ? {} : { title: opts.title }),
  };
  if (archToastTimer !== undefined) clearTimeout(archToastTimer);
  archToastTimer = setTimeout(() => {
    archToast.value = null;
  }, opts.ms ?? TOAST_MS);
}
function sendArchive(kind: "run" | "bash", id: string, set: "archive" | "unarchive"): void {
  const control = hub?.control;
  if (control === undefined) return;
  void control.setArchived(props.agent.key, kind, id, set);
}
function undoArchive(): void {
  const t = archToast.value;
  if (t !== null && t.undo) sendArchive(t.kind, t.id, "unarchive");
  archToast.value = null;
}
onBeforeUnmount(() => {
  if (archToastTimer !== undefined) clearTimeout(archToastTimer);
});
provide(FLEET_ARCHIVE, {
  canArchive: computed(() => hub?.control !== undefined),
  archive: (kind, id, label) => {
    sendArchive(kind, id, "archive");
    showArchToast(t("fleet.archivedToast", { name: label }), { kind, id, undo: true });
  },
  unarchive: (kind, id) => sendArchive(kind, id, "unarchive"),
  // 2026-10-28 rework (acceptance blocker: "clicking does nothing"): the op's outcome is now
  // REPORTED. Three distinct shapes, never the same render:
  //   changed > 0  →「已归档 N 条更早的任务」(the next `status.archived` frame moves the rows into
  //                  the fold and the `(+N more)` line disappears);
  //   changed === 0 →「没有可归档的任务」 (an honest no-op instead of a silent dead button);
  //   error/timeout →「归档失败」+ the code in `title`, i.e. a failure affordance that lasts
  //                  longer (8s) and never pretends to have archived anything.
  // No undo affordance on the bulk path: it has no single id to reverse (un-archive per row from
  // the fold instead). `n` is only gone: the agent re-derives (and re-counts) the real set, and the toast copy uses its answer.
  archiveOmitted: async (): Promise<void> => {
    const control = hub?.control;
    if (control?.archiveOmitted === undefined) {
      showArchToast(t("fleet.archiveOmittedFailed"), { title: "E_UNSUPPORTED", ms: TOAST_ERR_MS });
      return;
    }
    let changed: number | undefined;
    let code = "E_DEADLINE";
    try {
      const outcome = await control.archiveOmitted(props.agent.key, "bash");
      if (outcome.ok) {
        const data = outcome.data as { changed?: unknown } | undefined;
        changed = typeof data?.changed === "number" ? data.changed : 0;
      } else {
        code = outcome.error ?? "E_UNKNOWN";
      }
    } catch {
      code = "E_NETWORK";
    }
    if (changed === undefined) {
      showArchToast(t("fleet.archiveOmittedFailed"), { title: code, ms: TOAST_ERR_MS });
      return;
    }
    showArchToast(changed > 0 ? t("fleet.archiveOmittedDone", { n: changed }) : t("fleet.archiveOmittedNone"));
  },
});

// ---------------------------------------------------------------------------
// 树视图数据 + run 选择接缝(FLEET_SELECT,§6.3)
// ---------------------------------------------------------------------------
const rows = computed(() => props.agent.fleet as unknown as readonly FleetRowWire[]);
const treeNodes = computed(() => buildFleetTree(liveRows.value));
const orphans = computed(() => orphanRunIds(liveRows.value));
/* 2026-10-16 user ("红框部分感觉有点丑"): with no sub-agent rows (and no omitted counts) the
 * tree renders nothing, so the bash group's own top divider would sit right under the
 * header's bottom border — a double line around an empty gap. Solo ⇒ no divider. */
const treeEmpty = computed(() => {
  const om = props.agent.fleetOmitted;
  return treeNodes.value.length === 0 && !((om?.active ?? 0) > 0 || (om?.terminal ?? 0) > 0);
});
const showAgent = computed(() => props.panel !== "bash");
const showBash = computed(() => props.panel !== "agent");
const selectedRunId = computed(() => (showAgent.value ? (props.agent.runSel ?? null) : null));

// 2026-10-15 bash→fleet 迁移(用户拍板 L1):主会话后台 bash 任务作为树视图末尾的独立
// 「bash」分组(FleetBashJobs),wire 同原详情头部面板(`StatusInfo.bashJobs`,经
// bashJobsOf narrowed;缺失/零行 ⇒ 分组不出现,旧 hub/agent 与现状一致)。agent 计数
// (fleetSummary/徽标)不混入 bash。
const bashJobs = computed(() => bashJobsOf(props.agent));

// ---------------------------------------------------------------------------
// fleet-fill-budget(docs/dev/web-hub/fleet-fill-budget.md;2026-10-28 用户需求「调配显示数量
// 把整个高度填满」):按 `.tree-scroll` 的 clientHeight 实测可用高度,动态分配 agent 树顶层 /
// bash 分组各显示多少条已结束行。要点:
// - 行高/附加高度全部实测已渲染行的 offsetHeight(--fs-scale 字号缩放与密度变化自适应),
//   不写死像素;测不到(happy-dom 返回 0、无 ResizeObserver 的旧浏览器)⇒ computeFillBudget
//   返回 null ⇒ 子组件收到 undefined ⇒ 旧固定 3/5 行为,字节不变。
// - 可用高度只取 clientHeight(不取 scrollHeight):预算改变 → 内容高度改变不会反过来改变
//   clientHeight,无反馈环。ResizeObserver 回调天然按帧对齐(每帧至多一次),无需再加节流
//   (requestAnimationFrame 被 source-scan 全仓禁用,§3.5)。不新增任何 timer。
// - bash 行高/折叠按钮高用 last-good 缓存:预算把 bash 组收起后行不在 DOM,仍用上次实测值。
// ---------------------------------------------------------------------------
const treeScrollEl = ref<HTMLElement | null>(null);
const fillBudget = ref<FillBudget | null>(null);
/** 首轮测量是否已完成(2026-10-28 验收 #1):true 且预算仍 null ⇒ 测量失败,FleetBashJobs
 *  回退到与不传 fill 完全一致的旧默认开合。 */
const fillReady = ref(false);
let lastAgentRowPx = 0;
let lastBashRowPx = 0;
// 验收 #4:两块折叠按钮(.run-more)高度分别测量、分别缓存;未测到时用该块已测行高估计。
let lastAgentFoldPx = 0;
let lastBashFoldPx = 0;

// 验收 #3:用户手动操作回传 —— bash 组开合 / 两块「显示已完成」点击都改变该块的高度诉求,
// 以用户操作为准重分(FillOverrides),手动状态一旦置位不被预算覆盖。
const bashUserOpen = ref<boolean | null>(null);
const bashShowAll = ref(false);
const agentShowAll = ref(false);
function onBashOpenChange(open: boolean): void {
  bashUserOpen.value = open;
  void nextTick(recomputeFill);
}
function onBashShowAll(): void {
  bashShowAll.value = true;
  void nextTick(recomputeFill);
}
function onAgentShowAll(): void {
  agentShowAll.value = true;
  void nextTick(recomputeFill);
}

const fillCounts = computed<FillCounts>(() => {
  const nodes = showAgent.value ? treeNodes.value : [];
  const jobs = showBash.value ? bashJobs.value : undefined;
  const liveBashRows = jobs === undefined ? [] : jobs.rows.filter((r) => bashArchive.value.has(String(r.id)) !== true);
  let bashMust = 0;
  for (const r of liveBashRows) if (statusToken(r).live) bashMust++;
  return {
    agentFixedRows: fixedAgentRowCount(nodes),
    agentTerminalTop: topTerminalRowCount(nodes),
    bashMustRows: bashMust,
    bashTerminalRows: liveBashRows.length - bashMust,
  };
});

function recomputeFill(): void {
  const el = treeScrollEl.value;
  if (el === null) return;
  const agentRow = el.querySelector<HTMLElement>(".tree .run")?.offsetHeight ?? 0;
  if (agentRow > 0) lastAgentRowPx = agentRow;
  const bashRow = el.querySelector<HTMLElement>(".fleet-bash .bj-row")?.offsetHeight ?? 0;
  if (bashRow > 0) lastBashRowPx = bashRow;
  // 验收 #4:两块折叠按钮分别测量(agent 的是 tree-scroll 直属的 .run-more;bash 的在
  // .bj-fill-more 里)。首轮按钮还没渲染 ⇒ 0 ⇒ 下面用该块行高估计,不按 0 预留。
  const agentFold = el.querySelector<HTMLElement>(":scope > .run-more")?.offsetHeight ?? 0;
  if (agentFold > 0) lastAgentFoldPx = agentFold;
  const bashFold = el.querySelector<HTMLElement>(".fleet-bash .bj-fill-more .run-more")?.offsetHeight ?? 0;
  if (bashFold > 0) lastBashFoldPx = bashFold;
  let agentExtraPx = 0;
  for (const p of el.querySelectorAll<HTMLElement>(".fleet-omitted")) agentExtraPx += p.offsetHeight;
  // Whole archived section (fold header + its rows once the user opened it), not just the header.
  agentExtraPx += el.querySelector<HTMLElement>(".fleet-archived")?.offsetHeight ?? 0;
  let bashHeaderPx = el.querySelector<HTMLElement>(".fleet-bash .bj-sum")?.offsetHeight ?? 0;
  bashHeaderPx += el.querySelector<HTMLElement>(".fleet-bash .bj-archived-fold")?.offsetHeight ?? 0;
  for (const p of el.querySelectorAll<HTMLElement>(".fleet-bash .bj-more")) bashHeaderPx += p.offsetHeight;
  fillBudget.value = computeFillBudget(
    {
      heightPx: contentHeightOf(el),
      agentRowPx: lastAgentRowPx,
      bashRowPx: lastBashRowPx,
      agentExtraPx,
      bashHeaderPx,
      agentFoldPx: lastAgentFoldPx > 0 ? lastAgentFoldPx : lastAgentRowPx,
      bashFoldPx: lastBashFoldPx > 0 ? lastBashFoldPx : lastBashRowPx,
    },
    fillCounts.value,
    {
      bashCollapsed: bashUserOpen.value === false,
      agentShowAll: agentShowAll.value,
      bashShowAll: bashShowAll.value,
    },
  );
  fillReady.value = true;
}

/** clientHeight includes the scroller's own padding and the Bash group's top margin/border —
 *  neither can hold rows, so counting them made an "exactly full" budget overflow by ~8–10px
 *  (verify r2). Computed styles are read per measure (cheap; no layout thrash beyond the
 *  offsetHeight reads already done). */
function contentHeightOf(el: HTMLElement): number {
  const px = (v: string): number => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const cs = getComputedStyle(el);
  let h = el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  const bash = el.querySelector<HTMLElement>(".fleet-bash");
  if (bash !== null) {
    const bs = getComputedStyle(bash);
    h -= px(bs.marginTop) + px(bs.borderTopWidth) + px(bs.borderBottomWidth) + px(bs.marginBottom);
  }
  return Math.max(0, h);
}

function onArchivedOpen(): void {
  void nextTick(recomputeFill);
}

let unobserveFill: (() => void) | undefined;
// tree-scroll 只在树视图(未选中 run)时存在:用 ref watch 接管挂载/卸载,flush:"post"
// 保证元素插入且子组件渲染后再测量。immediate 覆盖常规挂载路径。
watch(
  treeScrollEl,
  (el) => {
    unobserveFill?.();
    unobserveFill = undefined;
    if (el !== null) unobserveFill = observeResize(el, recomputeFill);
    void nextTick(recomputeFill);
  },
  { immediate: true, flush: "post" },
);
// 行数变化(fleet 帧/bash 帧)后重算:等 DOM 更新再测;字符串键避免同值重复触发。
watch(
  () => {
    const c = fillCounts.value;
    return `${c.agentFixedRows}/${c.agentTerminalTop}/${c.bashMustRows}/${c.bashTerminalRows}`;
  },
  () => {
    void nextTick(recomputeFill);
  },
);
onBeforeUnmount(() => unobserveFill?.());

// A mode/width or panel transition invalidates cached line heights; measure the rendered panel.
watch(
  () => [props.panel, props.mode, props.open] as const,
  () => {
    lastAgentRowPx = lastBashRowPx = lastAgentFoldPx = lastBashFoldPx = 0;
    fillBudget.value = null;
    fillReady.value = false;
    void nextTick(recomputeFill);
  },
);

const agentTerminalBudget = computed(() => fillBudget.value?.agentTerminal);
const bashTerminalBudget = computed(() => fillBudget.value?.bashTerminal);

// ---------------------------------------------------------------------------
// sysload plan §6.4/§7.4/§10 (package P4): the crit/warn dispatch-paused banner, reading the
// SESSION's own gating truth (`StatusInfo.loadGate`, mirrored onto `AgentState.loadGate` by
// `@logic/state.js`'s "status" case) — distinct from `LoadPill`/`LoadCard`'s hub-GLOBAL reading
// (§3/§7.2: the hub carries no gate concept at all). `bannerNow` is a light local tick so the
// tweak-③ duration annex keeps counting up while the drawer stays open between status frames.
// ---------------------------------------------------------------------------
const bannerNow = ref(Date.now());
let bannerTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  bannerTimer = setInterval(() => {
    bannerNow.value = Date.now();
  }, 5_000);
});
onBeforeUnmount(() => {
  if (bannerTimer !== undefined) clearInterval(bannerTimer);
});
const banner = computed(() => bannerView(props.agent.loadGate, props.agent.loadGateReceivedAt, bannerNow.value));

const env = inject(CONTROL_ENV, null);
const canOpen = computed(() => runTranscriptAvailable(props.agent.card, env?.authMode) && hub?.selectRun !== undefined);
provide(FLEET_SELECT, {
  canOpen,
  select(runId: string): void {
    if (!canOpen.value) return;
    hub?.selectRun?.(props.agent.key, runId);
  },
});

/** Task60 §3: isConnected/hidden 不足以证明可见 —— 入口可能在 Teleport 迁移窗口或
 * display:none/inert 祖先内。实际可见（checkVisibility；happy-dom/旧浏览器回退旧语义）
 * 且无 inert 祖先才可作为焦点归还目标。 */
function focusTargetVisible(el: HTMLElement): boolean {
  if (!el.isConnected || el.hidden) return false;
  for (let p: HTMLElement | null = el; p !== null; p = p.parentElement) if (p.inert) return false;
  return typeof el.checkVisibility !== "function" || el.checkVisibility();
}
function restoreTrigger(): void {
  const split = rootEl.value?.closest(".detail-split");
  const trigger = props.trigger;
  const fallback = split?.querySelector<HTMLElement>(
    props.panel === undefined
      ? '[aria-controls="fleet-drawer"]'
      : `[data-panel="${props.panel}"][aria-controls="fleet-drawer"]`,
  );
  // close/Esc 先关闭并迁回浮动宿主（nextTick 后），再归还：此时按钮在浮动宿主内可见。
  if (trigger !== null && trigger !== undefined && focusTargetVisible(trigger)) trigger.focus();
  else if (fallback != null && focusTargetVisible(fallback)) fallback.focus();
  else document.getElementById("transcript")?.focus();
}
function onClose(): void {
  emit("close");
  if (props.panel !== undefined) void nextTick(restoreTrigger);
}
/** 「← 子 agent 列表」:退选 run(订阅由 useHub 拆除),抽屉保持打开、回到树视图。 */
function onBackToTree(): void {
  hub?.selectRun?.(props.agent.key, null);
}

// ---------------------------------------------------------------------------
// §6.4 键盘/指针契约(唯一 owner)
// ---------------------------------------------------------------------------
function onKey(ev: KeyboardEvent): void {
  if (ev.key === "Tab" && props.mode === "fullscreen") {
    const elements = Array.from(
      rootEl.value?.querySelectorAll<HTMLElement>(
        'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]',
      ) ?? [],
    );
    const first = elements[0],
      last = elements[elements.length - 1];
    if (
      first &&
      last &&
      (!rootEl.value?.contains(document.activeElement) ||
        (ev.shiftKey ? document.activeElement === first : document.activeElement === last))
    ) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
    return;
  }
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
  emit("close"); // outside clicks retain their own natural focus
}

watch(
  () => [props.mode, props.open] as const,
  ([mode, open], _prev, onCleanup) => {
    if (!open || (mode === "docked" && props.panel === undefined)) return;
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
// Only keyboard opens move focus. Legacy standalone callers retain their prior behavior.
watch(
  () => props.open,
  async (open, wasOpen) => {
    if (open === wasOpen) return;
    if (open) {
      if (props.panel === undefined ? props.mode === "docked" : props.openOrigin !== "keyboard") return;
      await nextTick();
      if (props.open) rootEl.value?.querySelector<HTMLElement>(".drawer-close")?.focus();
    } else if (props.panel === undefined && props.mode !== "docked") restoreTrigger();
  },
);
// Fullscreen is modal, without stealing focus on pointer opens. Cleanup on resize/unmount.
watch(
  () => [props.mode, props.open] as const,
  async ([mode, open], _old, cleanup) => {
    let disposed = false;
    const restored: Array<[HTMLElement, boolean]> = [];
    cleanup(() => {
      disposed = true;
      for (const [el, inert] of restored) el.inert = inert;
    });
    if (mode !== "fullscreen" || !open) return;
    await nextTick();
    if (disposed) return;
    // Inert every background sibling up to body (header/sidebar/topbar included), not just
    // the transcript column. Preserve pre-existing inert values for nested-overlay cleanup.
    let branch: HTMLElement | null = rootEl.value;
    while (branch?.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const el of Array.from(parent.children)) {
        if (!(el instanceof HTMLElement) || el === branch) continue;
        restored.push([el, el.inert]);
        el.inert = true;
      }
      if (parent === document.body) break;
      branch = parent;
    }
  },
);
</script>

<template>
  <aside
    id="fleet-drawer"
    ref="rootEl"
    class="fleet-drawer"
    :data-mode="mode"
    :data-panel="panel"
    :data-open="open || undefined"
    :role="mode === 'docked' ? undefined : 'dialog'"
    :aria-modal="mode === 'fullscreen' ? true : undefined"
    :aria-label="t(panel === 'bash' ? 'fleet.commandsTitle' : 'fleet.panelTitle')"
    @click.capture="onDrawerClick"
  >
    <!-- The activity host remains mounted across tree/run transitions. -->
    <div class="drawer-head">
      <template v-if="selectedRunId === null">
        <AppIcon :name="panel === 'bash' ? 'terminal' : 'bot'" class="icon-sm drawer-title-icon" />
        <span class="drawer-title">{{ t(panel === "bash" ? "fleet.commandsTitle" : "fleet.panelTitle") }}</span>
      </template>
      <slot name="activity"></slot>
      <button
        v-if="selectedRunId === null"
        class="btn btn-ghost btn-icon drawer-close"
        type="button"
        :aria-label="t('drawer.close')"
        @click="onClose"
      >
        <AppIcon name="x" class="icon-sm" />
      </button>
    </div>
    <template v-if="selectedRunId !== null">
      <RunHeader :agent="agent" :mode="mode" @back="onBackToTree" @close="onClose" />
      <RunTranscript :key="selectedRunId" :agent="agent" :now="now" />
    </template>
    <template v-else>
      <div v-if="banner && showAgent" class="ld-banner" :data-level="banner.level">
        <AppIcon name="alert" class="icon-sm" />
        <span class="ld-banner-body">
          <strong>{{ t("load.bannerPaused") }}</strong>
          <template v-if="banner.durationText">
            · {{ banner.level.toUpperCase() }} ({{ banner.durationText }})</template
          >
          <template v-else> · {{ banner.level.toUpperCase() }}</template>
        </span>
      </div>
      <div ref="treeScrollEl" class="tree-scroll">
        <FleetTree
          v-if="showAgent"
          :nodes="treeNodes"
          :now="now"
          :orphans="orphans"
          :omitted="agent.fleetOmitted"
          :terminal-budget="agentTerminalBudget"
          @show-all-terminal="onAgentShowAll"
        />
        <!-- web-hub archive plan: the archived-runs fold (hidden when nothing archived). -->
        <FleetArchived
          v-if="showAgent && archivedRows.length > 0"
          :rows="archivedRows"
          :set="runArchive"
          @update:open="onArchivedOpen"
        />
        <!-- 2026-10-15:子 agent 树之后的独立 bash 分组(无任务/无字段 ⇒ 不渲染)。 -->
        <FleetBashJobs
          v-if="showBash && bashJobs"
          :class="{ 'fleet-bash-solo': !showAgent || treeEmpty }"
          :jobs="bashJobs"
          :now="now"
          :archived="bashArchive"
          :fill="true"
          :fill-ready="fillReady"
          :terminal-budget="bashTerminalBudget"
          @update:open="onBashOpenChange"
          @show-all-terminal="onBashShowAll"
        />
      </div>
    </template>
  </aside>
  <!-- web-hub archive plan: the shared toast (viewport-fixed; the tree's and the bash group's
       archive actions land here). A single-row archive shows「撤销」; the bulk `archive_omitted`
       click shows its outcome (done / nothing to do / failed + code in `title`). -->
  <div v-if="archToast !== null" class="arch-toast" role="status" :title="archToast.title">
    <span class="arch-toast-text">{{ archToast.text }}</span>
    <button v-if="archToast.undo" class="btn btn-ghost arch-toast-undo" type="button" @click="undoArchive">
      {{ t("fleet.undo") }}
    </button>
  </div>
</template>
