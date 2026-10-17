<!--
  Host-load popover card (sysload plan §7.4/视觉稿 loadcard-{light,dark}-760): per-metric detail
  behind `LoadPill.vue`'s trigger. Esc / outside-pointerdown close + focus-return mirror
  `QuotaCard.vue`'s desktop popover exactly (non-modal `role="dialog"`, no Tab trap,
  `preventDefault()` on Esc).

  Wire-shape honesty (deviations from the approved mockup, recorded — the mockup predates the P0
  type freeze and shows a richer sampler than `LoadWire` actually carries):
  - no PSI-memory row and no Swap section — `LoadMemWire`/`LoadWire` carry neither (only
    `cpu.psiPct` and the display-only `io.psiPct` exist on the wire, §5.1/§7.1).
  - MEM shows `usedPct`/`availPct` only (no absolute GiB total/used/available) — `LoadMemWire`
    carries no byte totals.
  - the footer never says "派发已暂停" (dispatch pause) — §7.2: "hub 不承载 gate 概念，Pill/Card
    只显示等级，绝不写「已暂停派发」". That text belongs ONLY to `FleetDrawer`'s banner, which
    reads the SESSION's own `StatusInfo.loadGate` — a hub-global card has no gate concept to
    report. Instead the footer discloses the threshold SOURCE (§3: "阈值取自 hub 启动配置").

  Mockup tweak ① (已获批): top-process columns are already comm-aggregated BY THE WIRE (§5.5's
  `LoadTopRowWire`) — this component only renders the aggregated rows plus their `pids[]`
  expansion, never re-aggregates. Tweak ②: the disk row's subline shows free space in GiB
  (`fmtGiB`). Tweak ③ lives in `FleetDrawer.vue`, not here.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { UseHubHandle } from "../../composables/useHub.js";
import { HUB_CTX } from "../control/controlContext.js";
import { elapsedSinceMs, fmtDurationShort, fmtGiB, levelRank, pct, topRowView } from "@logic/load.js";
import type { LoadDiskWire, LoadTopRowWire, LoadTopWire, LoadWire } from "@protocol/messages.js";
import "../../styles/load.css";

const props = defineProps<{
  load: LoadWire;
  receivedAt: number | undefined;
  now: number;
  anchorEl: HTMLElement | null;
  /** Hover-peek mount (LoadPill, QuotaCard precedent): never steals focus on mount nor returns
   *  it on close — the pointer never asked for focus. Mount-time snapshot on purpose. */
  peek?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const wasPeek = props.peek === true;

// §7.1/§10 (package P4): `LoadCard.vue` is one of the components guaranteed to receive the REAL
// `useHub()` object (App.vue's sole construction site) through `HUB_CTX` — same precedent as
// `DashboardView.vue`'s `loadOlder` cast (that file's own header explains why `HubHandle` stays
// minimal rather than widened for a single extra method).
function fetchLoadTop(): void {
  (hub as UseHubHandle | null)?.fetchLoadTop();
}

onMounted(async () => {
  fetchLoadTop();
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  await nextTick();
  if (!wasPeek) panelEl.value?.focus();
});
onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  if (!wasPeek) props.anchorEl?.focus();
});

const panelEl = ref<HTMLElement | null>(null);

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  emit("close");
}
function onPointerDown(ev: PointerEvent): void {
  if (!(ev.target instanceof Node)) return;
  const panel = panelEl.value;
  if (panel !== null && panel.contains(ev.target)) return;
  if (props.anchorEl !== null && props.anchorEl.contains(ev.target)) return;
  ev.preventDefault();
  emit("close");
}

const level = computed(() => levelRank(props.load.level));
const levelToken = computed(() => props.load.level.toUpperCase());

/** 2026-10-16 field report 「一直显示 0s 前更新」: frames arrive every sample interval (or, on an
 *  unchanged fingerprint, every third one) while the pill only re-ticks every 5s, so a healthy
 *  feed always read "0s–4s ago". Until the frame nears the pill's own 4×interval staleness line
 *  the card just says 「实时」; only a lagging feed shows its age. */
const updatedText = computed(() => {
  if (typeof props.receivedAt !== "number") return undefined;
  const ms = props.now - props.receivedAt;
  if (ms < 0) return undefined;
  const interval = Number.isFinite(props.load.intervalMs) && props.load.intervalMs > 0 ? props.load.intervalMs : 5_000;
  if (ms < interval * 4) return t("load.updatedJustNow");
  return t("load.updatedAgo", { ago: fmtDurationShort(ms) });
});

/** How long the OVERALL level has held (receive-time anchored, §10 包注 P0·M9) — rendered next
 *  to the level badge as "CRIT · 2m", mirroring `FleetDrawer`'s banner duration annex. */
const sinceText = computed(() => {
  const ms = elapsedSinceMs(props.receivedAt, props.load.sinceAgoMs, props.now);
  return ms === undefined ? undefined : fmtDurationShort(ms);
});

function barLevel(l: "ok" | "warn" | "crit" | "unknown"): 0 | 1 | 2 | 3 {
  return levelRank(l);
}

const cpu = computed(() => props.load.cpu);
const mem = computed(() => props.load.mem);
const io = computed(() => props.load.io);
const loadavg = computed(() => props.load.loadavg);
const disks = computed((): readonly LoadDiskWire[] => props.load.disks ?? []);

function diskLabel(d: LoadDiskWire): string {
  return d.label === "~" ? t("load.diskHome") : d.path;
}
function diskFreeText(d: LoadDiskWire): string | undefined {
  if (d.skipped !== undefined) return undefined;
  const g = fmtGiB(d.freeBytes);
  return g === undefined ? undefined : t("load.diskFree", { gib: g });
}
function diskSkipText(d: LoadDiskWire): string | undefined {
  if (d.skipped === "remote") return t("load.diskRemote");
  if (d.skipped === "unresolved") return t("load.diskUnresolved");
  return undefined;
}

// ---------------------------------------------------------------------------
// Top processes (§5.5/§7.3 — on-demand `GET /api/load/top`, driven by `fetchLoadTop()` above)
// ---------------------------------------------------------------------------
const loadTop = computed(() => hub?.state.value.loadTop);
const expanded = ref<Set<string>>(new Set());
function rowKey(kind: "cpu" | "rss", comm: string, i: number): string {
  return `${kind}:${i}:${comm}`;
}
function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}
function rows(list: readonly LoadTopRowWire[] | undefined, kind: "cpu" | "rss") {
  return (list ?? []).map((row, i) => ({ key: rowKey(kind, row.comm, i), view: topRowView(row, kind) }));
}
const topData = computed((): LoadTopWire | undefined => loadTop.value?.data);
const topLoading = computed(() => loadTop.value?.loading === true && topData.value === undefined);
const topError = computed(() => loadTop.value?.error);
const topRetryAfter = computed(() => loadTop.value?.retryAfterS);
const byCpuRows = computed(() => rows(topData.value?.byCpu, "cpu"));
const byRssRows = computed(() => rows(topData.value?.byRss, "rss"));
</script>

<template>
  <div id="load-panel" ref="panelEl" class="ld-card" role="dialog" :aria-label="t('load.title')" tabindex="-1">
    <div class="ld-card-head">
      <span class="ld-card-title">
        {{ t("load.title") }}
        <span class="ld-level-badge" :data-level="level">{{ levelToken }}</span>
      </span>
      <span v-if="updatedText" class="ld-card-updated">{{ updatedText }}</span>
    </div>
    <div v-if="sinceText" class="ld-card-since">{{ t("load.sinceDuration", { duration: sinceText }) }}</div>

    <div v-if="cpu || io" class="ld-section">
      <div class="ld-section-title">{{ t("load.sectionCpu") }}</div>
      <div v-if="cpu" class="ld-row">
        <span class="ld-label">{{ t("load.cpuBusy") }}</span>
        <span class="ld-bar" :data-lv="barLevel(cpu.level)"><i :style="{ width: pct(cpu.busyPct) + '%' }"></i></span>
        <span class="ld-val">{{ pct(cpu.busyPct) }}%</span>
      </div>
      <div v-if="cpu && cpu.psiPct !== undefined" class="ld-row">
        <span class="ld-label">{{ t("load.psiCpu") }}</span>
        <span class="ld-bar" :data-lv="barLevel(cpu.level)"><i :style="{ width: pct(cpu.psiPct) + '%' }"></i></span>
        <span class="ld-val">{{ pct(cpu.psiPct) }}%</span>
      </div>
      <div v-if="io && io.psiPct !== undefined" class="ld-row">
        <span class="ld-label">{{ t("load.psiIo") }}</span>
        <span class="ld-bar" data-lv="0"><i :style="{ width: pct(io.psiPct) + '%' }"></i></span>
        <span class="ld-val">{{ pct(io.psiPct) }}%</span>
      </div>
    </div>

    <div v-if="mem" class="ld-section">
      <div class="ld-section-title">{{ t("load.sectionMem") }}</div>
      <div class="ld-row">
        <span class="ld-label">{{ t("load.memUsed") }}</span>
        <span class="ld-bar" :data-lv="barLevel(mem.level)"><i :style="{ width: pct(mem.usedPct) + '%' }"></i></span>
        <span class="ld-val">{{ pct(mem.usedPct) }}%</span>
      </div>
      <div class="ld-subrow">
        <span>{{ t("load.memAvail", { pct: pct(mem.availPct) }) }}</span
        ><span></span>
      </div>
    </div>

    <div v-if="loadavg" class="ld-section">
      <div class="ld-section-title">{{ t("load.sectionLoadavg") }}</div>
      <div class="ld-row">
        <span class="ld-label">{{ t("load.loadavgLabel") }}</span>
        <span class="ld-bar" :data-lv="level">
          <i :style="{ width: Math.min(100, (loadavg[0] / Math.max(1, cpu?.cores ?? 1)) * 100) + '%' }"></i>
        </span>
        <span class="ld-val">{{ loadavg[0].toFixed(1) }}</span>
      </div>
      <div class="ld-subrow">
        <span>
          {{ loadavg[0].toFixed(1) }} / {{ loadavg[1].toFixed(1) }} / {{ loadavg[2].toFixed(1) }}
          <template v-if="cpu">· {{ t("load.cores", { n: cpu.cores }) }}</template>
        </span>
        <span></span>
      </div>
    </div>

    <div v-if="disks.length > 0" class="ld-section">
      <div class="ld-section-title">{{ t("load.sectionDisk") }}</div>
      <template v-for="d in disks" :key="d.path">
        <div class="ld-mount-row">
          <span class="ld-mount-path">{{ diskLabel(d) }}</span>
          <span class="ld-bar" :data-lv="barLevel(d.level)">
            <i v-if="d.skipped === undefined" :style="{ width: pct(d.usedPct) + '%' }"></i>
          </span>
          <span class="ld-val">{{ d.skipped === undefined ? `${pct(d.usedPct)}%` : "—" }}</span>
        </div>
        <div v-if="diskFreeText(d) || diskSkipText(d)" class="ld-subrow">
          <span>{{ diskFreeText(d) ?? diskSkipText(d) }}</span>
          <span></span>
        </div>
      </template>
    </div>

    <div class="ld-section">
      <div class="ld-section-title">{{ t("load.sectionTop") }}</div>
      <p v-if="topLoading" class="ld-top-note">{{ t("load.topLoading") }}</p>
      <p v-if="topError" class="ld-top-note ld-top-error" role="alert">
        {{ t("load.topUnavailable") }} · {{ topError
        }}<template v-if="topRetryAfter !== undefined"> · {{ t("load.retryAfter", { n: topRetryAfter }) }}</template>
        <button type="button" class="ld-top-retry" @click="fetchLoadTop">{{ t("load.topRetry") }}</button>
      </p>
      <div v-if="topData" class="ld-proc-cols">
        <div>
          <div class="ld-proc-tab"><AppIcon name="cpu" class="icon-sm" />{{ t("load.topByCpu") }}</div>
          <div class="ld-proc-list">
            <template v-for="r in byCpuRows" :key="r.key">
              <button type="button" class="ld-proc-item" :aria-expanded="expanded.has(r.key)" @click="toggle(r.key)">
                <span class="ld-proc-name"
                  >{{ r.view.comm }}<template v-if="r.view.count > 1"> ×{{ r.view.count }}</template></span
                >
                <span class="ld-proc-val">{{ r.view.valueText }}<template v-if="r.view.avg"> ~</template></span>
              </button>
              <div v-if="expanded.has(r.key)" class="ld-proc-pids">
                <span v-for="p in r.view.pids" :key="p.pid" class="ld-proc-pid">{{ p.pid }}: {{ p.valueText }}</span>
              </div>
            </template>
          </div>
        </div>
        <div>
          <div class="ld-proc-tab"><AppIcon name="layers" class="icon-sm" />{{ t("load.topByRss") }}</div>
          <div class="ld-proc-list">
            <template v-for="r in byRssRows" :key="r.key">
              <button type="button" class="ld-proc-item" :aria-expanded="expanded.has(r.key)" @click="toggle(r.key)">
                <span class="ld-proc-name"
                  >{{ r.view.comm }}<template v-if="r.view.count > 1"> ×{{ r.view.count }}</template></span
                >
                <span class="ld-proc-val">{{ r.view.valueText }}</span>
              </button>
              <div v-if="expanded.has(r.key)" class="ld-proc-pids">
                <span v-for="p in r.view.pids" :key="p.pid" class="ld-proc-pid">{{ p.pid }}: {{ p.valueText }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
      <p v-else-if="!topError && !topLoading" class="ld-top-note">{{ t("load.topUnavailable") }}</p>
    </div>

    <div class="ld-foot">{{ t("load.footerThresholds") }}</div>
  </div>
</template>
