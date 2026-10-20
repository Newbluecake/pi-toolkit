<!--
  Read-only prompt-cache keepalive panel (cache-keepalive-web plan §4, P-B): a collapsed one-line
  marker in the detail header (the info block's last row), fed by `StatusInfo.cacheKeepalive` (P-A
  wire) via `cacheKeepaliveOf(agent)` in `DetailHeader` — no state.js mirror, no types.ts change
  (same posture as WorktreePanel).

  Collapsed (`cache 1h* · ping off:http 403 ·retry 25m ·t3`): `markerText()` re-assembles the TUI
  status line byte-parallel — the `·retry Xm` countdown is computed from the BROWSER clock
  (plan D3: `ping.retryAt` is an absolute agent-clock epoch; the value never rides the wire's
  fingerprint, so a local 30s ticker — `useTicker`, hidden-page-aware, minute granularity —
  refreshes it without any server frames). `keepalive off` is appended when the wire carries
  `enabled:false` (a runtime `/cache-ttl keepalive off`, D6). ALL compact markers are English
  tokens in both locales (AGENTS.md UI-text rule); prose labels live in the `cacheKeepalive`
  i18n namespace (D10 — never `detail.ts`).

  Expanded: a kv block (mode + explanation, enabled, last ping with kind/HTTP status/
  transient-permanent/attempts/age, window N/M, session totals, disabled reason) plus the line
  breaker list (label mono + `http 403` + `trips N` + `retry in Xm`/`eligible now` + current/
  legacy chips; non-open rows dimmed as `history`, `(+N more)` for `omitted`). The lastPing AGE
  also uses the browser clock (review r2 #5 — never frozen off `wire.at`). Strictly read-only:
  NO reset button, no armed display (D5/D11 — the wire carries neither).

  Ticker discipline (plan §4.2): the 30s ticker exists ONLY while ① some `retryAt` (ping or any
  line row) is still in the future — the collapsed marker keeps counting down even while the
  panel is folded — OR ② the panel is expanded AND a `lastPing` age is on display. Both false ⇒
  no timer at all; disposed on unmount.
-->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useTicker, type TickerHandle } from "../../composables/useTicker.js";
import type { CacheKeepaliveWire } from "@protocol/messages.js";
import {
  formatCacheCost,
  formatTokenCount,
  hasPendingRetry,
  lastPingView,
  lineRows,
  markerText,
  markerTone,
  modeToken,
  type KeepaliveLineRow,
} from "./cacheKeepaliveView.js";
import "../../styles/cache-keepalive.css";

// Deliberately local props interface (same escape hatch as WorktreePanel):
// contracts.ts is owned by another in-flight line and `CacheKeepaliveWire` comes straight from
// `@protocol/messages.js`.
const props = defineProps<{ readonly keepalive: CacheKeepaliveWire }>();
const { t } = useI18n();

const open = ref(false);

// ---------------------------------------------------------------------------
// browser-clock countdown (D3): `nowMs` advances only while a future retryAt exists OR the
// expanded panel shows a lastPing age; the 30s ticker is created/destroyed to match.
// ---------------------------------------------------------------------------
const nowMs = ref(Date.now());
let ticker: TickerHandle | null = null;
let stopNowBridge: (() => void) | null = null;

/** ① a pending retry (ping head or any line row) — counts down even while folded. */
const pendingRetry = computed(() => hasPendingRetry(props.keepalive, nowMs.value));
/** ② expanded AND a lastPing age is on display (the age advances with the browser clock). */
const expandedWithAge = computed(() => open.value && lastPingView(props.keepalive) !== undefined);
const needsTick = computed(() => pendingRetry.value || expandedWithAge.value);

function stopTicker(): void {
  stopNowBridge?.();
  stopNowBridge = null;
  ticker?.dispose();
  ticker = null;
}

watch(
  needsTick,
  (live) => {
    if (live && ticker === null) {
      const handle = useTicker({
        doc: document,
        win: window,
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h),
        now: () => Date.now(),
        intervalMs: 30_000,
      });
      ticker = handle;
      nowMs.value = handle.now.value;
      stopNowBridge = watch(handle.now, (v) => {
        nowMs.value = v;
      });
    } else if (!live) {
      stopTicker();
    }
  },
  { immediate: true },
);
onUnmounted(stopTicker);

// ---------------------------------------------------------------------------
// collapsed marker (English tokens in both locales; prose aria-label carries the meaning)
// ---------------------------------------------------------------------------
const marker = computed(() => markerText(props.keepalive, nowMs.value));
const tone = computed(() => markerTone(props.keepalive));
const toggleAria = computed(() => t("cacheKeepalive.summaryAria", { marker: marker.value }));

// ---------------------------------------------------------------------------
// expanded body
// ---------------------------------------------------------------------------
const mode = computed(() => modeToken(props.keepalive.mode, props.keepalive.dirty === true));
const enabledText = computed(() =>
  props.keepalive.enabled ? t("cacheKeepalive.enabledOn") : t("cacheKeepalive.enabledOff"),
);
const lastPing = computed(() => lastPingView(props.keepalive));
const lastPingStatus = computed(() =>
  lastPing.value?.status !== undefined ? `http ${lastPing.value.status}` : undefined,
);
const lastPingAttempts = computed(() => {
  const a = lastPing.value?.attempts;
  return a !== undefined && a > 0 ? `attempts ${Math.min(999, Math.max(1, Math.floor(a)))}` : undefined;
});
/** LastPing age from the BROWSER clock (review r2 #5) — `{age} ago` with the shared formatMsShort. */
const lastPingAge = computed(() => {
  const lp = lastPing.value;
  if (lp === undefined) return undefined;
  const age = nowMs.value - lp.at;
  if (!Number.isFinite(age) || age < 0) return undefined;
  return t("cacheKeepalive.lastPingAgo", {
    age: age < 60_000 ? "<1m" : `${Math.max(1, Math.floor(age / 60_000))}m`,
  });
});

const windowText = computed(() =>
  props.keepalive.window?.ended === true
    ? "ended"
    : `${props.keepalive.window?.pings ?? 0}/${props.keepalive.window?.max ?? 0}`,
);
const windowCapTitle = computed(() => {
  if (props.keepalive.window?.ended) return undefined;
  switch (props.keepalive.window?.maxSource) {
    case "priced":
      return "Prefix budget from model cache read/write prices";
    case "clamped":
      return "Price-derived prefix budget clamped to 96";
    case "fallback":
      return "Unpriced fallback 11; no profitability proof";
    default:
      return undefined;
  }
});
const sessionPings = computed(() => props.keepalive.session?.pings ?? 0);
const cacheReadText = computed(() => formatTokenCount(props.keepalive.session?.cacheReadTokens ?? 0));
const costText = computed(() => formatCacheCost(props.keepalive.session?.costUsd));
const avoidedText = computed(() => `${formatTokenCount(props.keepalive.session?.avoidedMissTokens ?? 0)} tok`);
const disabledAt = computed(() => {
  const at = props.keepalive.disabled?.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const age = nowMs.value - at;
  if (age < 0) return undefined;
  return t("cacheKeepalive.disabledSince", {
    ago: age < 60_000 ? "<1m" : `${Math.max(1, Math.floor(age / 60_000))}m`,
  });
});

const rows = computed(() => lineRows(props.keepalive));

/** `retry in Xm` (future retryAt, browser clock) / `eligible now` (open, elapsed) / nothing. */
function retryToken(row: KeepaliveLineRow): string | undefined {
  if (!row.open) return undefined;
  if (row.retryAt === undefined) return t("cacheKeepalive.lineEligibleNow");
  const left = row.retryAt - nowMs.value;
  if (left <= 0) return t("cacheKeepalive.lineEligibleNow");
  return t("cacheKeepalive.lineRetryIn", { dur: formatRetryDur(left) });
}

/** Minute-granularity duration for `retry in …` — the same formatMsShort scale as the marker. */
function formatRetryDur(ms: number): string {
  if (ms < 60_000) return "<1m";
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 120 ? `${minutes}m` : `${Math.min(24, Math.ceil(minutes / 60))}h`;
}

function lineChips(row: KeepaliveLineRow): string[] {
  const chips: string[] = [];
  if (row.current) chips.push(t("cacheKeepalive.lineCurrent"));
  if (row.wildcard) chips.push(t("cacheKeepalive.lineLegacy"));
  if (!row.open) chips.push(t("cacheKeepalive.lineHistory"));
  return chips;
}
</script>

<template>
  <section class="ck-panel" :data-open="open" :data-tone="tone" aria-readonly="true">
    <button class="ck-sum" type="button" :aria-expanded="open" :aria-label="toggleAria" @click="open = !open">
      <AppIcon name="radio" class="icon-sm" />
      <span class="ck-sum-text">{{ marker }}</span>
      <AppIcon name="chev-right" class="icon-sm chev" />
    </button>
    <div v-if="open" class="ck-body">
      <dl class="ck-kv">
        <div>
          <dt>{{ t("cacheKeepalive.rowMode") }}</dt>
          <dd>
            <span class="ck-token" translate="no">{{ mode }}</span>
            <span class="ck-note">{{ t("cacheKeepalive.modeAutoNote") }}</span>
          </dd>
        </div>
        <div>
          <dt>{{ t("cacheKeepalive.rowEnabled") }}</dt>
          <dd>{{ enabledText }}</dd>
        </div>
        <div>
          <dt>{{ t("cacheKeepalive.rowLastPing") }}</dt>
          <dd v-if="lastPing">
            <span class="ck-token" translate="no">{{ lastPing.kind }}</span>
            <span v-if="lastPingStatus" class="ck-token" translate="no">{{ lastPingStatus }}</span>
            <span
              v-if="lastPing.kind !== 'proven-hit'"
              class="ck-chip"
              :data-kind="lastPing.line ? 'line' : lastPing.transient === false ? 'permanent' : 'transient'"
            >
              {{
                lastPing.line
                  ? t("cacheKeepalive.lineTag")
                  : lastPing.transient === false
                    ? t("cacheKeepalive.permanentTag")
                    : t("cacheKeepalive.transientTag")
              }}
            </span>
            <span v-if="lastPingAttempts" class="ck-token" translate="no">{{ lastPingAttempts }}</span>
            <span v-if="lastPingAge" class="ck-age">{{ lastPingAge }}</span>
          </dd>
          <dd v-else>{{ t("cacheKeepalive.lastPingNone") }}</dd>
        </div>
        <div>
          <dt>{{ t("cacheKeepalive.rowWindow") }}</dt>
          <dd>
            <span class="ck-token" translate="no" :title="windowCapTitle">{{ windowText }}</span>
          </dd>
        </div>
        <div>
          <dt>{{ t("cacheKeepalive.rowSession") }}</dt>
          <dd>
            <span class="ck-token" translate="no">{{ sessionPings }} ping</span>
            <span class="ck-meta"
              >{{ t("cacheKeepalive.rowCacheRead") }} <span translate="no">{{ cacheReadText }}</span></span
            >
            <span class="ck-meta"
              >{{ t("cacheKeepalive.rowCost") }} <span translate="no">{{ costText }}</span></span
            >
            <span class="ck-meta"
              >{{ t("cacheKeepalive.rowAvoided") }} <span translate="no">{{ avoidedText }}</span></span
            >
            <span class="ck-meta"
              >{{ t("cacheKeepalive.rowLoadBearing") }}
              <span translate="no">{{ keepalive.session?.loadBearingWindows ?? 0 }}</span></span
            >
            <span class="ck-meta"
              >{{ t("cacheKeepalive.rowUnnecessary") }}
              <span translate="no">{{ keepalive.session?.unnecessaryWindows ?? 0 }}</span></span
            >
            <span class="ck-meta"
              >{{ t("cacheKeepalive.rowDiscarded") }}
              <span translate="no">{{ keepalive.session?.discardedWindows ?? 0 }}</span></span
            >
          </dd>
        </div>
        <div v-if="keepalive.disabled">
          <dt>{{ t("cacheKeepalive.rowDisabled") }}</dt>
          <dd>
            <span class="ck-token" translate="no">{{ keepalive.disabled.reason }}</span>
            <span v-if="keepalive.disabled.httpStatus !== undefined" class="ck-token" translate="no"
              >http {{ keepalive.disabled.httpStatus }}</span
            >
            <span class="ck-chip" :data-kind="keepalive.disabled.transient === true ? 'transient' : 'permanent'">
              {{
                keepalive.disabled.transient === true
                  ? t("cacheKeepalive.transientTag")
                  : t("cacheKeepalive.permanentTag")
              }}
            </span>
            <span v-if="disabledAt" class="ck-age">{{ disabledAt }}</span>
          </dd>
        </div>
      </dl>
      <div v-if="rows.length > 0" class="ck-lines">
        <div class="ck-lines-title">{{ t("cacheKeepalive.linesTitle") }}</div>
        <ul class="ck-lines-list">
          <li v-for="(row, i) in rows" :key="`${row.label}-${i}`" class="ck-line" :data-open="row.open">
            <span class="ck-line-label" translate="no" :title="row.label">{{ row.label }}</span>
            <span class="ck-line-meta">
              <span v-if="row.status !== undefined" class="ck-token" translate="no">http {{ row.status }}</span>
              <span class="ck-token" translate="no">trips {{ row.trips }}</span>
              <span v-if="retryToken(row)" class="ck-retry">{{ retryToken(row) }}</span>
              <span v-for="chip in lineChips(row)" :key="chip" class="ck-chip">{{ chip }}</span>
            </span>
          </li>
        </ul>
        <div v-if="keepalive.omitted !== undefined && keepalive.omitted > 0" class="ck-more">
          {{ t("cacheKeepalive.linesMore", { n: keepalive.omitted }) }}
        </div>
      </div>
      <div v-else class="ck-lines ck-lines-empty">{{ t("cacheKeepalive.linesNone") }}</div>
    </div>
  </section>
</template>
