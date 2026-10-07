<!--
  Conversation stream (ui-design.md §5.4/§6.4/§6.6, vue-plan.md v2.1 §3.6/§3.7 (deep-link scroll
  target)/§5.2 — P4). Owns: client-side windowing (`useTranscriptWindow`, cap 300 mounted
  `.tx-item`s), the scroll-anchor dance for prepended/appended content (the pure functions in
  `useFollowScroll.ts`), the near-top auto-`load-older` trigger, and the near-bottom
  auto-un-follow/auto-restore + "N new" counting: scrolling away from the bottom turns
  `following` off, scrolling back to within `NEAR_BOTTOM_PX` of the bottom by hand turns it back
  on (symmetric with the "N new" jump pill, so a user never gets stuck un-followed just because
  they scrolled back down themselves). `following`/`new-count` are owned by the caller (props +
  emits, not local state) — see the file-level note below on how "turn Follow back on" and
  "jump to bottom" collapse into the same thing.

  Scroll-position memory (docs/dev/web-hub-session-switch/plan.md §1.4 — E1, v1 最小闭环): all
  lengths/indices count ENTRIES from `buildTxEntries` (one coordinate system — a folded
  `toolResult` or an attached live tool used to desync the two index spaces), and a mount with a
  saved record (opt-in via the `memoryKey` prop, only DetailBody's main-session Transcript passes
  it) restores the remembered reading position instead of jumping to the bottom. scrollTop has
  exactly one gated writer per DOM change (W1 follow-on / W2a prepend / W2b follow-pin / W3
  content-growth pin / W4 restore); the restore write carries a one-shot token that its own
  scroll event consumes (no following flip, no load-older), and any user gesture cancels a
  still-pending restore.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { TranscriptEmits, TranscriptProps } from "../../contracts.js";
import "../../styles/transcript.css";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import {
  defaultWindowSize,
  repositionAfterPage,
  TRANSCRIPT_CAP,
  useTranscriptWindow,
} from "../../composables/useTranscriptWindow.js";
import {
  buildAnchorIndex,
  findAnchor,
  pickAnchor,
  restoreStart,
  SCROLL_MEMORY,
} from "../../composables/useScrollMemory.js";
import {
  applyScrollCompensation,
  captureScroll,
  NEAR_BOTTOM_PX,
  type FollowScrollSnapshot,
} from "../../composables/useFollowScroll.js";
import AppIcon from "../../icons/AppIcon.vue";
import ToolCard from "./ToolCard.vue";
import TxAssistant from "./TxAssistant.vue";
import TxCustom from "./TxCustom.vue";
import TxDivider from "./TxDivider.vue";
import TxHiddenGap from "./TxHiddenGap.vue";
import TxUser from "./TxUser.vue";
import { buildTxEntries } from "./entries.js";

/** Distance (px) from the top under which an auto `load-older` fires — mirrors the legacy
 * scroll-triggered pagination threshold (plan §3.6); not a frozen/shared constant elsewhere. */
const PAGE_TRIGGER_PX = 96;

const props = withDefaults(defineProps<TranscriptProps>(), { anchorId: "transcript" });
const emit = defineEmits<TranscriptEmits>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 480px)");
// E1-2 single coordinate system: EVERY length/index below counts entries
// (`build.entries`), not items+streaming+tools — streaming and an orphan live tool each occupy
// exactly one trailing entry, a paired toolResult occupies none, and an attached live tool
// occupies none, so the window, domSignal, N-new baseline, paging shift and anchors all share
// one index space (fixes the pre-E1 two-space drift the v1 review's Blocker-4 flagged).
const build = computed(() => buildTxEntries(props.agent));
const entriesLen = computed(() => build.value.entries.length);

// ---------------------------------------------------------------------------
// scroll memory (session-switch plan §1.4 E1-6): read at setup (initial window + restore plan),
// written at unmount. Only a caller that passes `memoryKey` participates — the drawer's
// RunTranscript never does, so it neither reads nor writes.
// ---------------------------------------------------------------------------
const memory = props.memoryKey !== undefined ? inject(SCROLL_MEMORY, null) : null;
/** Pending W4 restore — set in setup when a usable record exists, executed (or cancelled) at
 * `onMounted → nextTick`. While non-null, W2b/W3 let go (E1-5's writer table). */
let restorePhase: { readonly ids: readonly string[]; readonly offsetPx: number } | null = null;
let restoreFailed = false;
let initialStart: number | undefined;
if (memory !== null && props.memoryKey !== undefined) {
  const rec = memory.get(props.memoryKey);
  if (rec !== undefined && !rec.following && rec.anchorIds !== undefined && rec.anchorIds.length > 0) {
    const j = findAnchor(buildAnchorIndex(build.value.anchors), rec.anchorIds);
    if (j === undefined) {
      restoreFailed = true; // anchor cut out of the tail snapshot, or ambiguous — degrade
    } else {
      initialStart = restoreStart(j, entriesLen.value, defaultWindowSize(mobile.matches.value));
      restorePhase = { ids: rec.anchorIds, offsetPx: rec.anchorOffsetPx ?? 0 };
    }
  }
}

const transcriptWindow = useTranscriptWindow(entriesLen, mobile.matches, TRANSCRIPT_CAP, initialStart);
const view = computed(() => transcriptWindow.window.value);
const windowedEntries = computed(() => build.value.entries.slice(view.value.start, view.value.end));

/** Join byte for the `data-anchor-ids` attribute (never appears in an entry id/messageKey). */
const ANCHOR_JOIN = "\u001f";

/** `data-anchor-ids` value for the entry at `entryIndex` (undefined ⇒ the attribute is omitted —
 * streaming/live-tool/no-identity rows never anchor). Read back with `getAttribute` + split,
 * never woven into a CSS selector. */
function anchorAttr(entryIndex: number): string | undefined {
  const ids = build.value.anchors[entryIndex];
  if (ids === undefined || ids.length === 0) return undefined;
  return ids.join(ANCHOR_JOIN);
}

function anchorIdsFromAttr(el: Element): readonly string[] | null {
  const raw = el.getAttribute("data-anchor-ids");
  if (raw === null || raw === "") return null;
  return raw.split(ANCHOR_JOIN);
}

const scrollBox = ref<HTMLElement | null>(null);
const innerBox = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// following / new-count
// ---------------------------------------------------------------------------
let notFollowingBaselineLen = entriesLen.value;
const newCount = computed(() => (props.following ? 0 : Math.max(0, entriesLen.value - notFollowingBaselineLen)));
watch(newCount, (n) => emit("new-count", n));

function scrollToBottom(): void {
  const box = scrollBox.value;
  if (box) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// touch-scroll pin suppression (mobile field report: a slow finger drag while pinned at the
// bottom got fought by the follow-pin machinery — every streaming re-render / status tick
// re-forced `scrollTop = scrollHeight` mid-drag → jitter/flicker; a fast fling escaped
// NEAR_BOTTOM_PX before the next pin landed, so only slow drags hurt). While a touch scroll
// is active — and for a short settle window after release so momentum/settle doesn't race the
// next pin — ALL programmatic pins (follow-on jump, scroll-anchor follow-branch, in-place
// growth pin) are SKIPPED, not queued: the next real content change after the settle pins
// again if still following. `onScroll`'s following-flip logic is untouched (a drag that
// crosses NEAR_BOTTOM_PX still turns following off naturally). Mouse/wheel/keyboard behavior
// is unchanged: a pointerdown only arms the flag for pointerType "touch".
// ---------------------------------------------------------------------------
const TOUCH_SCROLL_SETTLE_MS = 200;
let userTouchScrolling = false;
let touchSettleTimer: ReturnType<typeof setTimeout> | undefined;

function clearTouchSettleTimer(): void {
  if (touchSettleTimer !== undefined) {
    clearTimeout(touchSettleTimer);
    touchSettleTimer = undefined;
  }
}

function beginTouchScroll(): void {
  onUserGesture();
  userTouchScrolling = true;
  // A re-grip inside the settle window keeps suppression alive instead of letting the
  // pending settle timer release mid-drag.
  clearTouchSettleTimer();
}

function onPointerDown(e: PointerEvent): void {
  // E1-5 (Major-7): ALL pointer types count as user intent for the scroll-memory restore —
  // a mouse press on the scrollbar/selection is just as much "the user is driving" as a
  // touch. The touch-only pin-suppression arming below stays separate.
  onUserGesture();
  if (e.pointerType === "touch") beginTouchScroll();
}

function endTouchScroll(): void {
  if (!userTouchScrolling) return;
  clearTouchSettleTimer();
  touchSettleTimer = setTimeout(() => {
    touchSettleTimer = undefined;
    userTouchScrolling = false;
  }, TOUCH_SCROLL_SETTLE_MS);
}

// Turning Follow on (the dock switch, or the "↓ Latest · N new" button — both just set the same
// `following` prop true from the caller's side) IS "jump to latest": reset the window to the
// tail and scroll to the bottom.
watch(
  () => props.following,
  (isFollowing) => {
    if (isFollowing) {
      restorePhase = null; // W1: user/external intent outranks a still-pending restore (E1-5)
      transcriptWindow.resetToLatest();
      void nextTick(() => {
        if (!userTouchScrolling) scrollToBottom();
      });
    } else {
      notFollowingBaselineLen = entriesLen.value;
    }
  },
  { immediate: true },
);

function onScroll(): void {
  const box = scrollBox.value;
  if (!box) return;
  // The W4 restore write's own scroll event: consume the one-shot token and do nothing — no
  // following flip, no auto load-older (E1-5). The NEXT scroll event is handled normally.
  if (programmaticScroll) {
    programmaticScroll = false;
    return;
  }
  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (props.following && distanceFromBottom > NEAR_BOTTOM_PX) emit("update:following", false);
  // Symmetric auto-restore: scrolling back down to near the bottom turns `following` back on,
  // same as the "N new" jump pill — without this, a user who scrolls away and then scrolls back
  // to the tail by hand stayed un-followed forever. Strict `<=`/`>` on either side of the SAME
  // threshold (not two offset bands) keeps the two branches mutually exclusive so a single
  // scroll event can only ever flip one way, never oscillate.
  else if (!props.following && distanceFromBottom <= NEAR_BOTTOM_PX) emit("update:following", true);
  if (box.scrollTop < PAGE_TRIGGER_PX && view.value.hiddenBefore === 0 && props.agent.hasMore && !props.agent.paging) {
    emit("load-older");
  }
}

// ---------------------------------------------------------------------------
// scroll anchoring (pre-patch snapshot → post-patch compensation)
// ---------------------------------------------------------------------------
let pendingSnapshot: FollowScrollSnapshot | undefined;
let prepended = false;
const domSignal = computed(() => `${view.value.start}:${view.value.end}:${entriesLen.value}`);

watch(
  domSignal,
  () => {
    pendingSnapshot = scrollBox.value ? captureScroll(scrollBox.value) : undefined;
  },
  { flush: "pre" },
);
watch(
  domSignal,
  () => {
    if (scrollBox.value)
      applyScrollCompensation(scrollBox.value, pendingSnapshot ?? captureScroll(scrollBox.value), {
        // A prepended page still anchors even mid-touch-drag (it protects the user's reading
        // position); only the follow-pin branch — the one that fights the finger — is gated.
        // `restorePhase === null` is E1-5's W2b gate: while a restore is pending, W4 is the
        // only scrollTop writer allowed.
        following: props.following && !userTouchScrolling && restorePhase === null,
        prepended,
      });
    prepended = false;
  },
  { flush: "post" },
);

function showEarlier(): void {
  restorePhase = null; // W2a (E1-5): paging back cancels any pending restore first
  prepended = true;
  transcriptWindow.showEarlier();
}

// ---------------------------------------------------------------------------
// follow-pin on in-place content growth (bug: streaming text grows an EXISTING
// assistant message without changing `entriesLen`/the window, so `domSignal` never fires and
// the view never re-pins to the bottom — this observer catches that case independently). Bounded
// to a single pin per microtask (several ResizeObserver entries can land in the same tick) and
// never fires while `following` is off, so it can never fight the user scrolling up — rAF is
// banned repo-wide (`tests/web-hub/ui/source-scan.test.ts`), hence the microtask coalesce
// instead of the rAF throttle a vanilla implementation would reach for.
let pinQueued = false;
function schedulePin(): void {
  if (pinQueued) return;
  pinQueued = true;
  void Promise.resolve().then(() => {
    pinQueued = false;
    const box = scrollBox.value;
    // `restorePhase === null` is E1-5's W3 gate: W4 owns scrollTop while a restore is pending.
    if (box && props.following && !userTouchScrolling && restorePhase === null) box.scrollTop = box.scrollHeight;
  });
}

let contentResizeObserver: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver !== "undefined" && innerBox.value) {
    contentResizeObserver = new ResizeObserver(schedulePin);
    contentResizeObserver.observe(innerBox.value);
  }
  // W4 — the one and only restore write (E1-5): runs after the first paint (nextTick) so the
  // anchor row exists and has its layout position. A user gesture (or W1's following=true)
  // may have cancelled the restore in the meantime — then this is a no-op. A record whose
  // anchor could not be resolved at setup (`restoreFailed`) hands the position back to the
  // caller: emit following=true and let W1's jump-to-bottom take over.
  void nextTick(() => {
    if (restorePhase !== null) {
      const phase = restorePhase;
      restorePhase = null;
      const box = scrollBox.value;
      const inner = innerBox.value;
      let written = false;
      if (box !== null && inner !== null) {
        const el = findAnchorElement(inner, phase.ids);
        if (el !== null) {
          const contentTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
          writeScrollTop(contentTop - phase.offsetPx);
          written = true;
        }
      }
      if (!written) emit("update:following", true); // the anchor vanished between setup and paint
    } else if (restoreFailed) {
      restoreFailed = false;
      emit("update:following", true);
    }
  });
});
onBeforeUnmount(() => {
  saveScrollMemory(); // E1-6: while the DOM is still in the document — rows/geometry readable
  contentResizeObserver?.disconnect();
  contentResizeObserver = undefined;
  clearTouchSettleTimer();
});

// A server page landing while the client window was already sitting at `start === 0` (the only
// condition under which `load-older` is ever emitted, see `onScroll`/the template button) grows
// the transcript without changing what's *mounted* — re-anchor `start` on the entry that was
// first mounted when paging began (E1-2: by entry KEY, because the page can fold existing
// entries — e.g. its toolCall pairs up with a previously-orphan toolResult — so a plain
// length-delta shift no longer keeps the same entries on screen; the delta shift remains as
// the fallback when that key itself was folded away). No scroll compensation is needed for
// this case: nothing in the mounted window actually moved.
let lenAtPagingStart = entriesLen.value;
let pagingAnchorKey: string | undefined;
watch(
  () => props.agent.paging,
  (isPaging, wasPaging) => {
    if (isPaging) {
      lenAtPagingStart = entriesLen.value;
      pagingAnchorKey = build.value.entries[view.value.start]?.key;
    } else if (wasPaging) {
      transcriptWindow.start.value = repositionAfterPage(
        transcriptWindow.start.value,
        pagingAnchorKey,
        build.value.entries,
        lenAtPagingStart,
      );
    }
  },
);

function jumpToLatest(): void {
  emit("update:following", true); // the watcher above does the actual reset + scroll
}

// ---------------------------------------------------------------------------
// scroll-memory restore primitives (E1-5) — used only by W4 above
// ---------------------------------------------------------------------------

/** One-shot token: the scroll event caused by W4's own scrollTop assignment. `onScroll`
 * consumes it instead of treating the restore as user scrolling. */
let programmaticScroll = false;

/** The single gated programmatic write used by the restore (E1-5): skip sub-pixel no-ops,
 * otherwise write and arm the one-shot scroll-event token. The other programmatic writers
 * (W1's jump, the prepend compensation, the follow pins) keep writing directly — their scroll
 * events land within NEAR_BOTTOM_PX and never flip anything. */
function writeScrollTop(top: number): void {
  const box = scrollBox.value;
  if (box === null) return;
  const target = Math.max(0, top);
  if (Math.abs(box.scrollTop - target) < 1) return;
  programmaticScroll = true;
  box.scrollTop = target;
}

/** First mounted row whose anchor-id set intersects `ids` (any shared id restores). */
function findAnchorElement(root: ParentNode, ids: readonly string[]): Element | null {
  const want = new Set(ids);
  for (const el of root.querySelectorAll("[data-anchor-ids]")) {
    const attr = anchorIdsFromAttr(el);
    if (attr === null) continue;
    for (const id of attr) {
      if (want.has(id)) return el;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// user gestures (E1-5, v2 review Major-7) — a gesture never scrolls itself, it only (a) clears
// the W4 token so the RESTORE's scroll event (if any slipped in before the gesture) is treated
// as user scrolling, and (b) cancels a still-pending restore back to today's follow behavior.
// Mounted on the scroll box itself (keyboard only reaches the FOCUSED scroll container), for
// every pointer type — separate from the touch-only pin suppression above.
// ---------------------------------------------------------------------------
const SCROLL_GESTURE_KEYS: ReadonlySet<string> = new Set([
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  " ",
]);

function onUserGesture(): void {
  programmaticScroll = false;
  if (restorePhase !== null) {
    restorePhase = null;
    emit("update:following", true); // back to today's behavior: follow the tail
  }
}

function onKeyGesture(e: KeyboardEvent): void {
  if (SCROLL_GESTURE_KEYS.has(e.key)) onUserGesture();
}

// ---------------------------------------------------------------------------
// save (E1-3/E1-6): on unmount, while this component's DOM is still in the document, remember
// either "was following" or "the first visible anchorable row + its pixel offset".
// ---------------------------------------------------------------------------
function saveScrollMemory(): void {
  if (memory === null || props.memoryKey === undefined) return;
  const key = props.memoryKey;
  if (props.following) {
    memory.set(key, { following: true });
    return;
  }
  const box = scrollBox.value;
  const inner = innerBox.value;
  if (box === null || inner === null) {
    memory.set(key, { following: false });
    return;
  }
  // Rows carry RAW ids from the DOM attribute; filter them through the unambiguous set so a
  // row whose every id is ambiguous contributes nothing (pickAnchor then looks further down).
  const unambiguous = buildAnchorIndex(build.value.anchors);
  const boxTop = box.getBoundingClientRect().top;
  const rows: { ids: string[]; top: number; bottom: number }[] = [];
  for (const el of inner.querySelectorAll("[data-anchor-ids]")) {
    const attr = anchorIdsFromAttr(el);
    if (attr === null) continue;
    const ids = attr.filter((id) => unambiguous.has(id));
    if (ids.length === 0) continue;
    const rect = el.getBoundingClientRect();
    const top = rect.top - boxTop + box.scrollTop;
    rows.push({ ids, top, bottom: top + rect.height });
  }
  const picked = pickAnchor(rows, box.scrollTop);
  if (picked === undefined) {
    memory.set(key, { following: false }); // nothing anchorable on screen — next mount degrades
  } else {
    memory.set(key, { following: false, anchorIds: picked.ids, anchorOffsetPx: picked.offsetPx });
  }
}
</script>

<template>
  <section
    ref="scrollBox"
    :id="anchorId"
    class="transcript"
    tabindex="-1"
    :aria-label="ariaLabel ?? t('transcript.ariaLabel')"
    @scroll="onScroll"
    @wheel.passive="onUserGesture"
    @keydown="onKeyGesture"
    @touchstart.passive="beginTouchScroll"
    @touchend.passive="endTouchScroll"
    @touchcancel.passive="endTouchScroll"
    @pointerdown.passive="onPointerDown"
    @pointerup.passive="endTouchScroll"
    @pointercancel.passive="endTouchScroll"
  >
    <div ref="innerBox" class="tx-inner">
      <TxHiddenGap v-if="view.hiddenBefore > 0" direction="before" :count="view.hiddenBefore" @action="showEarlier" />
      <template v-else-if="agent.history === 'loaded' && agent.hasMore">
        <div v-if="agent.paging" class="tx-divider tx-item">
          <span class="label">{{ t("transcript.loadingOlder") }}</span>
        </div>
        <button v-else class="btn tx-older" type="button" @click="emit('load-older')">
          <AppIcon name="arrow-up" />{{ t("transcript.loadOlderMessages") }}
        </button>
      </template>

      <template v-for="(entry, i) in windowedEntries" :key="entry.key">
        <TxUser
          v-if="entry.type === 'user'"
          :text="entry.text"
          :truncated="entry.truncated"
          :timestamp="entry.timestamp"
          :data-anchor-ids="anchorAttr(view.start + i)"
        />
        <TxAssistant
          v-else-if="entry.type === 'assistant'"
          :assistant="entry.assistant"
          :truncated="entry.truncated"
          :data-anchor-ids="anchorAttr(view.start + i)"
        />
        <div
          v-else-if="entry.type === 'toolOrphan'"
          class="msg-tool tx-item"
          :data-anchor-ids="anchorAttr(view.start + i)"
        >
          <ToolCard :view="entry.view" />
        </div>
        <TxCustom
          v-else-if="entry.type === 'custom'"
          :custom-type="entry.customType"
          :text="entry.text"
          :truncated="entry.truncated"
          :data-anchor-ids="anchorAttr(view.start + i)"
        />
        <TxDivider
          v-else-if="entry.type === 'compaction'"
          icon="layers"
          :label="t('transcript.compacted')"
          :summary="entry.summary"
          :truncated="entry.truncated"
          :data-anchor-ids="anchorAttr(view.start + i)"
        />
        <TxDivider
          v-else-if="entry.type === 'branchSummary'"
          icon="layers"
          :label="t('transcript.branchSummary')"
          :summary="entry.summary"
          :truncated="entry.truncated"
          :data-anchor-ids="anchorAttr(view.start + i)"
        />
        <TxDivider
          v-else-if="entry.type === 'modelChange'"
          icon="swap"
          :label="
            entry.model ? t('transcript.modelChange', { model: entry.model }) : t('transcript.modelChangeUnknown')
          "
          :data-anchor-ids="anchorAttr(view.start + i)"
        />
        <div v-else class="msg-other tx-item" :data-anchor-ids="anchorAttr(view.start + i)">
          <div class="msg-role">{{ entry.role }}</div>
          <div class="msg-text">{{ entry.text }}</div>
        </div>
      </template>

      <TxHiddenGap v-if="view.hiddenAfter > 0" direction="after" :count="view.hiddenAfter" @action="jumpToLatest" />

      <div v-if="agent.history === 'waiting'" class="tx-status" aria-busy="true">
        {{ t("transcript.loadingHistory") }}
      </div>
      <div v-if="agent.history === 'error'" class="tx-status tx-error">
        {{ t("transcript.historyError", { error: agent.historyError ?? "error" }) }}
      </div>
    </div>
  </section>
</template>
