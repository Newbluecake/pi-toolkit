<!--
  Top-bar subscription-quota pill (quota-web plan §3/D1/D6/D7 + the 2026-10 multi-group
  requirements). Self-contained: owns its own `open`/anchor state (same pattern as `TopBar.vue`'s
  gear + `SettingsOverlay`), so `TopBar.vue` only ever mounts this one component. Renders nothing
  (`v-if="display"`) when `quota` is absent or carries no windowed providers — the caller
  (`TopBar.vue`) additionally never mounts this component at all in that case (a `v-for` over a
  0/1-item list, NOT a `v-if`, so the "off" state leaves literally zero extra DOM nodes — see
  `TopBar.vue`'s own comment for why a plain `v-if` cannot achieve that in Vue's compiled output).

  Display modes (2026-10-08 user rulings, `logic/quota.js`'s `pillDisplay`):
  - available (≥1 group at level<3): ONLY the available groups render, each with BOTH its
    windows (5h first, then 7d — each window's own pct) plus its D6 reset annex; exhausted
    groups are hidden from the pill's face but stay in aria/title (discoverable via hover/SR).
  - exhausted (ALL groups level 3): every group renders as `⚠ Label · 7d {clock} 重置` (clock
    from the group's weekResetAt; omitted when unknown) — "什么订阅可用" collapsed into "什么时候
    恢复".
  The GLM pair (`zai-coding-cn`+`zai`) ALWAYS merges into one "GLM" group when both are present
  (`glmPair`, 2026-10-14 ruling — values per scope = worst-of the two sides; an intl-only
  snapshot labels "GLM" too); an
  exhausted group never loses its label — ⚠ is only ever a prefix. The pill's own `data-level`
  is the max level among the SHOWN groups (border/background semantics).

  `nowTick` is the one local timer this package owns: every absolute timestamp (`resetAt`) is
  re-formatted from scratch each tick (D2 — the agent never re-pushes purposefully for a clock
  edge), at a 60s cadence (reset times are never shown to the minute of the *next* minute, so a
  shorter cadence buys nothing). Passed down to `QuotaCard` so both surfaces repaint in lockstep
  off one timer instead of two independently-phased ones.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { fmtResetAt, pillDisplay, pillGroups, scopeLabel } from "@logic/quota.js";
import type { QuotaWire } from "@protocol/messages.js";
import QuotaCard from "./QuotaCard.vue";
import "../../styles/quota.css";

/** Mirrors `pillGroups`/`pillDisplay`'s JSDoc return shapes (`logic/quota.js` — the module is
 *  JS, so the contract is re-declared here for vue-tsc; keys are always present, *At may be
 *  undefined). */
interface PillWindow {
  scope: "5h" | "week";
  level: 0 | 1 | 2 | 3;
  usedPct: number;
}

interface PillGroup {
  ids: string[];
  labelId: string;
  level: 0 | 1 | 2 | 3;
  scope: "5h" | "week";
  usedPct: number;
  windows: PillWindow[];
  weekResetAt: number | undefined;
  resetScope: "5h" | "week" | undefined;
  resetAt: number | undefined;
  available: boolean;
}

interface PillDisplay {
  mode: "available" | "exhausted";
  groups: PillGroup[];
}

const props = defineProps<{ quota: QuotaWire | undefined }>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 767px)").matches;

const nowTick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now();
  }, 60_000);
});
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});

/** What the pill's FACE shows (available-only / exhausted week-resets). */
const display = computed((): PillDisplay | null => pillDisplay(props.quota) as PillDisplay | null);
/** ALL groups — the aria/title source: hidden exhausted groups stay discoverable (2026-10-08). */
const allGroups = computed((): PillGroup[] => pillGroups(props.quota) as PillGroup[]);

/** The pill's own level = max among the SHOWN groups — keeps the whole-pill border/background
 *  ladder (exhausted-only mode is always 3 by construction). */
const pillLevel = computed(() => {
  const groups = display.value?.groups ?? [];
  return Math.max(0, ...groups.map((g) => g.level));
});

const open = ref(false);
const btnEl = ref<HTMLButtonElement | null>(null);

function onToggle(): void {
  open.value = !open.value;
}
function onClose(): void {
  open.value = false;
}

function providerLabel(id: string): string {
  const key = `quota.provider.${id}`;
  const label = t(key);
  // Unknown provider id (a future wire peer): t() falls back to the raw key — degrade to the
  // bare id instead, never "quota.provider.xxx" (verifier 2026-10).
  return label === key ? id : label;
}

function clockOf(at: number | undefined): string | undefined {
  return at === undefined ? undefined : fmtResetAt(at, nowTick.value);
}

/** One group's reset annex ("· {clock} reset"), or "" when no reset annex applies (D6). */
function resetAnnex(g: PillGroup): string {
  const clock = clockOf(g.resetAt);
  return clock === undefined ? "" : ` · ${t("quota.resetSuffix", { clock })}`;
}

/** Available mode: `GLM 5h 17% · 7d 43% · {clock} reset` (both windows, 5h first — each
 *  window's own pct; D6 annex at the end). Exhausted mode: `⚠ Kimi · 7d {clock} reset` (clock
 *  from the week window, omitted when unknown). */
function segText(g: PillGroup): string {
  const label = providerLabel(g.labelId);
  const exhausted = display.value?.mode === "exhausted";
  if (exhausted) {
    const clock = clockOf(g.weekResetAt);
    if (mobile.value) return clock === undefined ? `⚠ ${label}` : `⚠ ${label} ${clock}`;
    return clock === undefined ? `⚠ ${label} · 7d` : `⚠ ${label} · 7d ${t("quota.resetSuffix", { clock })}`;
  }
  if (mobile.value) {
    // `GLM 17%/43%` — pct-only, 5h/7d order; a single-window provider shows just its one pct.
    return `${label} ${g.windows.map((w) => `${w.usedPct}%`).join("/")}`;
  }
  const windows = g.windows.map((w) => `${scopeLabel(w.scope)} ${w.usedPct}%`).join(" · ");
  return `${label} ${windows}${resetAnnex(g)}`;
}

/** One group's aria sentence (existing `pillAriaBase`/`pillAriaReset` templates, one per group
 *  — headline window + D6 annex; applies to hidden exhausted groups too). */
function groupAria(g: PillGroup): string {
  const provider = providerLabel(g.labelId);
  const scope = scopeLabel(g.scope);
  if (g.resetAt !== undefined) {
    const clock = fmtResetAt(g.resetAt, nowTick.value);
    if (clock !== undefined) return t("quota.pillAriaReset", { provider, scope, pct: g.usedPct, clock });
  }
  return t("quota.pillAriaBase", { provider, scope, pct: g.usedPct });
}

const ariaLabel = computed(() => allGroups.value.map(groupAria).join("; "));
</script>

<template>
  <span v-if="display" class="q-anchor">
    <button
      ref="btnEl"
      type="button"
      class="q-pill"
      :data-level="pillLevel"
      aria-haspopup="dialog"
      :aria-expanded="open"
      aria-controls="quota-panel"
      :aria-label="ariaLabel"
      :title="ariaLabel"
      @click="onToggle"
    >
      <span class="q-pill-text">
        <template v-for="(g, i) in display.groups" :key="g.labelId">
          <!-- Thin separator between groups (the "·" glyph is the mobile form; desktop CSS clips
               it down to a 1px rule so it never reads like the reset annex's own " · "). -->
          <span v-if="i > 0" class="q-sep" aria-hidden="true"> · </span>
          <span class="q-seg" :data-level="g.level">
            <span class="q-dot" aria-hidden="true"></span>
            <span class="q-seg-text">{{ segText(g) }}</span>
          </span>
        </template>
      </span>
    </button>
    <QuotaCard v-if="open && quota" :quota="quota" :now="nowTick" :anchor-el="btnEl" @close="onClose" />
  </span>
</template>
