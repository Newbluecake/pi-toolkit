<!--
  Conversation stream (ui-design.md §5.4/§6.4/§6.6, vue-plan.md v2.1 §3.6/§3.7 (deep-link scroll
  target)/§5.2 — P4). Owns: client-side windowing (`useTranscriptWindow`, cap 300 mounted
  `.tx-item`s), the scroll-anchor dance for prepended/appended content (the pure functions in
  `useFollowScroll.ts`), the near-top auto-`load-older` trigger, and the near-bottom
  auto-un-follow + "N new" counting. `following`/`new-count` are owned by the caller (props +
  emits, not local state) — see the file-level note below on how "turn Follow back on" and
  "jump to bottom" collapse into the same thing.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { TranscriptEmits, TranscriptProps } from "../../contracts.js";
import "../../styles/transcript.css";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { useTranscriptWindow } from "../../composables/useTranscriptWindow.js";
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

const props = defineProps<TranscriptProps>();
const emit = defineEmits<TranscriptEmits>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 480px)");
const totalLen = computed(() => props.agent.items.length + (props.agent.streaming ? 1 : 0) + props.agent.tools.length);
const build = computed(() => buildTxEntries(props.agent));
const transcriptWindow = useTranscriptWindow(totalLen, mobile.matches);
const view = computed(() => transcriptWindow.window.value);
const windowedEntries = computed(() => build.value.entries.slice(view.value.start, view.value.end));

const scrollBox = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// following / new-count
// ---------------------------------------------------------------------------
let notFollowingBaselineLen = totalLen.value;
const newCount = computed(() => (props.following ? 0 : Math.max(0, totalLen.value - notFollowingBaselineLen)));
watch(newCount, (n) => emit("new-count", n));

function scrollToBottom(): void {
  const box = scrollBox.value;
  if (box) box.scrollTop = box.scrollHeight;
}

// Turning Follow on (the dock switch, or the "↓ Latest · N new" button — both just set the same
// `following` prop true from the caller's side) IS "jump to latest": reset the window to the
// tail and scroll to the bottom.
watch(
  () => props.following,
  (isFollowing) => {
    if (isFollowing) {
      transcriptWindow.resetToLatest();
      void nextTick(scrollToBottom);
    } else {
      notFollowingBaselineLen = totalLen.value;
    }
  },
  { immediate: true },
);

function onScroll(): void {
  const box = scrollBox.value;
  if (!box) return;
  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (props.following && distanceFromBottom > NEAR_BOTTOM_PX) emit("update:following", false);
  if (box.scrollTop < PAGE_TRIGGER_PX && view.value.hiddenBefore === 0 && props.agent.hasMore && !props.agent.paging) {
    emit("load-older");
  }
}

// ---------------------------------------------------------------------------
// scroll anchoring (pre-patch snapshot → post-patch compensation)
// ---------------------------------------------------------------------------
let pendingSnapshot: FollowScrollSnapshot | undefined;
let prepended = false;
const domSignal = computed(() => `${view.value.start}:${view.value.end}:${totalLen.value}`);

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
        following: props.following,
        prepended,
      });
    prepended = false;
  },
  { flush: "post" },
);

function showEarlier(): void {
  prepended = true;
  transcriptWindow.showEarlier();
}

// A server page landing while the client window was already sitting at `start === 0` (the only
// condition under which `load-older` is ever emitted, see `onScroll`/the template button) grows
// `agent.items` without changing what's *mounted* — shift `start` forward by exactly the growth
// so the same items stay visible and the newly fetched ones simply become the next "N earlier
// hidden" batch (plan §3.6's "前插后 start 按前插数平移以保持锚点"). No scroll compensation is
// needed for this case: nothing in the mounted window actually moved.
let lenAtPagingStart = totalLen.value;
watch(
  () => props.agent.paging,
  (isPaging, wasPaging) => {
    if (isPaging) {
      lenAtPagingStart = totalLen.value;
    } else if (wasPaging) {
      const delta = totalLen.value - lenAtPagingStart;
      if (delta > 0) transcriptWindow.start.value += delta;
    }
  },
);

function jumpToLatest(): void {
  emit("update:following", true); // the watcher above does the actual reset + scroll
}
</script>

<template>
  <section
    ref="scrollBox"
    id="transcript"
    class="transcript"
    tabindex="-1"
    :aria-label="t('transcript.ariaLabel')"
    @scroll="onScroll"
  >
    <div class="tx-inner">
      <TxHiddenGap v-if="view.hiddenBefore > 0" direction="before" :count="view.hiddenBefore" @action="showEarlier" />
      <template v-else-if="agent.history === 'loaded' && agent.hasMore">
        <div v-if="agent.paging" class="tx-divider tx-item">
          <span class="label">{{ t("transcript.loadingOlder") }}</span>
        </div>
        <button v-else class="btn tx-older" type="button" @click="emit('load-older')">
          <AppIcon name="arrow-up" />{{ t("transcript.loadOlderMessages") }}
        </button>
      </template>

      <template v-for="entry in windowedEntries" :key="entry.key">
        <TxUser
          v-if="entry.type === 'user'"
          :text="entry.text"
          :truncated="entry.truncated"
          :timestamp="entry.timestamp"
        />
        <TxAssistant v-else-if="entry.type === 'assistant'" :assistant="entry.assistant" :truncated="entry.truncated" />
        <div v-else-if="entry.type === 'toolOrphan'" class="msg-tool tx-item"><ToolCard :view="entry.view" /></div>
        <TxCustom
          v-else-if="entry.type === 'custom'"
          :custom-type="entry.customType"
          :text="entry.text"
          :truncated="entry.truncated"
        />
        <TxDivider
          v-else-if="entry.type === 'compaction'"
          icon="layers"
          :label="t('transcript.compacted')"
          :summary="entry.summary"
          :truncated="entry.truncated"
        />
        <TxDivider
          v-else-if="entry.type === 'branchSummary'"
          icon="layers"
          :label="t('transcript.branchSummary')"
          :summary="entry.summary"
          :truncated="entry.truncated"
        />
        <TxDivider
          v-else-if="entry.type === 'modelChange'"
          icon="swap"
          :label="
            entry.model ? t('transcript.modelChange', { model: entry.model }) : t('transcript.modelChangeUnknown')
          "
        />
        <div v-else class="msg-other tx-item">
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
