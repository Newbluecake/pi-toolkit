<!--
  Non-modal floating ask_user window (user ruling 2026-10-20; approved mock
  `~/pwh-preview/askfloat/ask-float.png`). Replaces the old in-flow `.ask-user-slot` stack
  that covered the transcript bottom: ONE window now stacks every open dialog's
  `AskUserForm` (existing per-dialog rendering, drafts, suspended state, epoch notes, 409
  folding and the two-step cancel are all unchanged — this component only owns the chrome).

  - **Desktop (≥768px)**: a floating window (`position: fixed`, z-index above the fleet
    drawer/agents tree, below the real modals) whose default sits bottom-right just above the
    composer. The title bar is the drag handle (pointer events + capture, mouse and touch, no
    rAF; `useAskFloat.ts`), clamps to the WHOLE APP VIEWPORT below the top bar — it may be
    dragged across the agents tree / fleet drawer — persists per browser under
    `pwh_askfloat_pos` (validated + clamped on read), minimizes to the bar (button / Esc) and
    re-expands on click/Enter; arrow keys nudge. No backdrop, no focus trap, no scroll lock —
    the transcript beneath stays fully scrollable/selectable.
  - **Phone (<768px)**: a bottom sheet above the composer (not draggable) that collapses to a
    compact bar 「❓ n 个问题待回答 · 展开 ▲」 so the whole transcript stays readable.
  - A NEW dialog arriving while minimized/collapsed auto-expands once (attention) with a
    subtle pulse, and is announced through a local sr-only live region (AttachmentTray
    precedent; the announcement text is cleared a few seconds later so it is read once).

  The title is 「需要你回答」 for one dialog and 「需要你回答 · n 个问题」 for several —
  every stacked form is visible at once, so there is no "current" dialog to index.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DialogWire } from "@protocol/messages.js";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { ASK_FLOAT_KEYBOARD_STEP, useAskFloat } from "../../composables/useAskFloat.js";
import type { AskUserFloatEmits, AskUserFloatProps } from "../../contracts.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
import AppIcon from "../../icons/AppIcon.vue";
import AskUserForm from "./AskUserForm.vue";

const props = defineProps<AskUserFloatProps>();
const emit = defineEmits<AskUserFloatEmits>();
const { t } = useI18n();

const dialogs = computed(() => props.dialogs as readonly DialogWire[]);
const staleList = computed<readonly string[]>(() => props.staleIds ?? []);

// --- form factor: ≥768px floating window / <768px bottom sheet (both are CSS; the JS side
// only gates the drag) ---------------------------------------------------------------------
const desktopMedia = useMedia(window, "(min-width: 768px)");
const isDesktop = desktopMedia.matches;

// --- minimize / collapse (one flag: desktop title-bar collapse, phone compact bar) --------
const minimized = ref(false);
function minimize(): void {
  minimized.value = true;
}
function expand(): void {
  floatDrag.resetDragClick(); // a programmatic/keyboard expand is never a drag-end click
  minimized.value = false;
}

// --- drag / position (desktop only — the composable itself no-ops off the desktop band) ---
const anchorEl = ref<HTMLElement | null>(null);
const floatEl = ref<HTMLElement | null>(null);

/** Bottom edge of the top bar in viewport px — the clamp box starts here (0 = unmeasurable). */
function topOffset(): number {
  const el = document.querySelector("header.topbar");
  if (el === null) return 0;
  const r = el.getBoundingClientRect();
  return Number.isFinite(r.bottom) ? Math.max(0, r.bottom) : 0;
}

const floatDrag = useAskFloat({
  storage: browserLocalStorage(),
  desktop: isDesktop,
  anchor: anchorEl,
  float: floatEl,
  win: window,
  topOffset,
});

const posStyle = computed(() => {
  if (!isDesktop.value) return undefined;
  const p = floatDrag.pos.value ?? floatDrag.defaultPos.value;
  if (p === null) return undefined;
  return { left: `${p.x}px`, top: `${p.y}px`, right: "auto", bottom: "auto" };
});

// A bar swap (expanded div ↔ minimized button) must never leave a drag stuck on the detached
// element, and an expanded window must never extend below the composer/pane: cancel any
// in-flight drag on the flip and re-clamp once the expanded body has laid out again.
watch(minimized, (min) => {
  floatDrag.cancelDrag();
  if (!min) void nextTick(() => floatDrag.clampNow());
});

// A persisted position was read before layout existed; clamp it into the viewport once
// mounted, and again whenever the band flips back to desktop. The ResizeObserver re-runs
// clampNow when the window's own content height changes (question lists grow/shrink,
// suspended banner, …), when the PANE resizes (drawer toggle, column drag), and when the
// anchor's SIBLINGS resize — a growing dock (queue rows, chips) changes their size, not the
// pane's, and the default position must re-resolve off the anchor's top edge so the window
// keeps sitting just above the composer. Callback-driven, no rAF (renderGate rule).
let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  void nextTick(() => floatDrag.clampNow());
  if (typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(() => floatDrag.clampNow());
  if (floatEl.value !== null) resizeObserver.observe(floatEl.value);
  const anchor = anchorEl.value;
  if (anchor?.parentElement != null) {
    resizeObserver.observe(anchor.parentElement);
    let sib: Element | null = anchor.nextElementSibling;
    for (let n = 0; sib !== null && n < 4; n += 1) {
      // folded-note paragraphs + the DetailDock — bounded, detached nodes are auto-dropped
      resizeObserver.observe(sib);
      sib = sib.nextElementSibling;
    }
  }
});
watch(isDesktop, (on) => {
  if (on) void nextTick(() => floatDrag.clampNow());
});

// --- title bar ----------------------------------------------------------------------------
const TITLE_ID = "ask-float-title";

/** Minimized phone bar shows the pending count (「❓ n 个问题待回答」); everything else shows
 * 「需要你回答」 (one dialog) or 「需要你回答 · n 个问题」 (several stacked forms). */
const barTitle = computed(() => {
  const n = dialogs.value.length;
  if (!isDesktop.value && minimized.value) return t("dialog.floatPendingBar", { n });
  return n > 1 ? t("dialog.floatTitleMany", { n }) : t("dialog.floatTitleOne");
});

function onBarClick(): void {
  if (floatDrag.consumeDragClick()) return; // the click that ENDS a drag is not an expand
  expand();
}

function onBarKeydown(ev: KeyboardEvent): void {
  floatDrag.resetDragClick(); // keyboard activation must never be swallowed as a drag-end click
  if (ev.key === "Escape") {
    // User ruling: Esc NEVER cancels the dialog — it only minimizes an expanded window.
    if (!minimized.value) {
      minimize();
    }
    ev.stopPropagation(); // never fall through to DashboardView's global back-navigation
    return;
  }
  if (minimized.value || !isDesktop.value) return; // minimized bar: Enter/Space click natively
  switch (ev.key) {
    case "ArrowLeft":
      floatDrag.nudge(-ASK_FLOAT_KEYBOARD_STEP, 0);
      break;
    case "ArrowRight":
      floatDrag.nudge(ASK_FLOAT_KEYBOARD_STEP, 0);
      break;
    case "ArrowUp":
      floatDrag.nudge(0, -ASK_FLOAT_KEYBOARD_STEP);
      break;
    case "ArrowDown":
      floatDrag.nudge(0, ASK_FLOAT_KEYBOARD_STEP);
      break;
    default:
      return;
  }
  ev.preventDefault();
}

/** Esc anywhere inside the float (form inputs, options, …) minimizes the window and is
 * swallowed HERE — DashboardView's global Esc back-navigation must never see it (user ruling:
 * Esc NEVER cancels the dialog; the two-step cancel's own disarm Esc stops propagation first). */
function onRootKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  if (!minimized.value) minimize();
  ev.stopPropagation();
}

// --- new-dialog attention: auto-expand once + subtle pulse + sr-only announcement ---------
const announced = ref("");
const pulsing = ref(false);
const PULSE_MS = 2000; // covers the CSS pulse animation (0.9s × 2)
const ANNOUNCE_MS = 3000; // clear the sr-only announcement after it has been read once
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
let announceTimer: ReturnType<typeof setTimeout> | undefined;

const knownIds = new Set<string>(dialogs.value.map((d) => d.dialogId));
watch(dialogs, (list) => {
  let fresh = false;
  for (const d of list) {
    if (knownIds.has(d.dialogId)) continue;
    knownIds.add(d.dialogId);
    fresh = true;
  }
  if (!fresh) return;
  announced.value = t("dialog.floatNewQuestion");
  if (announceTimer !== undefined) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announced.value = "";
    announceTimer = undefined;
  }, ANNOUNCE_MS);
  if (minimized.value) {
    expand();
    pulsing.value = true;
    if (pulseTimer !== undefined) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      pulsing.value = false;
      pulseTimer = undefined;
    }, PULSE_MS);
  }
});

onBeforeUnmount(() => {
  if (pulseTimer !== undefined) clearTimeout(pulseTimer);
  if (announceTimer !== undefined) clearTimeout(announceTimer);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="anchorEl" class="ask-anchor">
    <section
      ref="floatEl"
      class="ask-float"
      :class="{ 'ask-float--min': minimized, 'ask-float--pulse': pulsing, 'ask-float--drag': floatDrag.dragging.value }"
      :style="posStyle"
      role="dialog"
      aria-modal="false"
      :aria-labelledby="TITLE_ID"
      @keydown="onRootKeydown"
    >
      <!-- minimized/collapsed: the whole bar is the expand button (click / Enter / Space) —
           still the drag handle on desktop, with the drag's trailing click suppressed -->
      <button
        v-if="minimized"
        type="button"
        class="ask-float-bar ask-float-bar--button"
        aria-expanded="false"
        aria-controls="ask-float-body"
        @pointerdown="floatDrag.onBarPointerDown"
        @keydown="onBarKeydown"
        @click="onBarClick"
      >
        <span v-if="isDesktop" class="ask-float-grip" aria-hidden="true">⠿</span>
        <span v-else class="ask-float-q" aria-hidden="true">❓</span>
        <span :id="TITLE_ID" class="ask-float-title">{{ barTitle }}</span>
        <span v-if="!isDesktop" class="ask-float-hint">{{ t("dialog.floatExpandShort") }}</span>
        <AppIcon name="arrow-up" class="icon-sm ask-float-chev" />
        <span class="sr-only">{{ t("dialog.floatExpand") }}</span>
      </button>

      <!-- expanded: title bar = drag handle (desktop) + keyboard target (arrows nudge, Esc
           minimizes — it NEVER cancels the dialog, per the user ruling) -->
      <div v-else class="ask-float-bar" tabindex="0" @pointerdown="floatDrag.onBarPointerDown" @keydown="onBarKeydown">
        <span v-if="isDesktop" class="ask-float-grip" aria-hidden="true">⠿</span>
        <span :id="TITLE_ID" class="ask-float-title">{{ barTitle }}</span>
        <span class="ask-float-spacer"></span>
        <!-- compact ruling: the 「也可以在终端作答——先答者生效」 hint shrinks to a muted
             title-bar token; the full sentence stays discoverable as the tooltip -->
        <span class="ask-float-term" :title="t('dialog.alsoInTerminal')">{{ t("dialog.floatTerminalHint") }}</span>
        <button
          type="button"
          class="ask-float-btn"
          aria-expanded="true"
          aria-controls="ask-float-body"
          :aria-label="isDesktop ? t('dialog.floatMinimize') : t('dialog.floatCollapse')"
          @click="minimize"
        >
          <span v-if="isDesktop" aria-hidden="true">−</span>
          <template v-else>{{ t("dialog.floatCollapse") }} <AppIcon name="chev-down" class="icon-sm" /></template>
        </button>
      </div>

      <!-- v-show, never v-if: the stacked forms stay MOUNTED while minimized so half-filled
           selections survive a collapse/expand round-trip -->
      <div v-show="!minimized" id="ask-float-body" class="ask-float-body">
        <section v-for="d in dialogs" :key="`${d.dialogId}:${epoch}`" class="ask-float-item">
          <p v-if="staleList.includes(d.dialogId)" class="ask-epoch-note" role="status">
            {{ t("dialog.epochChanged") }}
          </p>
          <AskUserForm
            :dialog="d"
            :suspended="suspended"
            @answer="emit('answer', d.dialogId, $event)"
            @cancel="emit('cancel', d.dialogId)"
          />
        </section>
      </div>
      <p class="sr-only" role="status">{{ announced }}</p>
    </section>
  </div>
</template>
