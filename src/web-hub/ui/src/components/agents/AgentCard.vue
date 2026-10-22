<!--
  One agent card (ui-design.md §5.1, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/agents/**`). Pure presentation over an already-derived `AgentCardView`
  (`agentCardModel.ts`'s `toAgentCardView`) — a real `<a href="#/agent/<key>">` so browser
  back/forward, middle-click-open-in-new-tab and Tab-order all work for free (ui-design §6.2).
-->
<script setup lang="ts">
import { xsBadgeOf, xsChannelChipOf, xsUnreadLabel, xsUnreadOf, type XsReceive } from "./agentCardModel.js";
import type { IconName } from "../../icons/names.js";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { observeResize } from "../../composables/useSharedResize.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { formatPercent } from "../../format.js";
import { isFreshlyRestored, managedFor, restoringKeys } from "../../logic/spawn.js";
import type { AgentCardProps } from "../../contracts.js";
import { HUB_CTX } from "../control/controlContext.js";
import { PRIVACY_LOCK_CTX } from "../privacy/privacyContext.js";

const props = defineProps<AgentCardProps>();
const i18n = useI18n();
const { t } = i18n;

// §7.4 (C5): an open ask_user dialog adds a "Needs answer" badge (the visual state pill keeps
// showing `waiting`). The frozen `AgentCardView` has no dialogs field, so the card looks its
// own agent up in the App.vue-provided `HUB_CTX` state (no provider ⇒ no badge).
const hub = inject(HUB_CTX, null);
const XS_ICON: Record<XsReceive, IconName> = { wake: "radio", deliver: "inbox", replies: "swap", off: "ban" };
const xsBadge = computed(() => xsBadgeOf(hub?.state.value.agents.get(props.card.key), hub?.state.value.hub?.["caps"]));
const xsUnread = computed(() =>
  xsUnreadOf(hub?.state.value.agents.get(props.card.key), hub?.state.value.hub?.["caps"]),
);
// channel-plan §7 (CHU): chip only for a channel set ≠ [default] and only with hub cap xs.channel.v1.
const xsChannels = computed(() =>
  xsChannelChipOf(hub?.state.value.agents.get(props.card.key), hub?.state.value.hub?.["caps"]),
);
const needsAnswer = computed(() => {
  const dialogs = hub?.state.value.agents.get(props.card.key)?.dialogs;
  return Array.isArray(dialogs?.open) && dialogs.open.length > 0;
});

// ---------------------------------------------------------------------------
// web-hub-privacy plan v2.1 (P2): the 标记入口 — a lock affordance on the card. 锁定态常显
// (a marked session ALWAYS shows the closed lock; clicking it opens the 取消标记 dialog — LAN
// password / loopback confirm); 未锁定悬停显示 (`.privacy-lock-btn[data-marked="false"]` is
// opacity-0 until hover/focus-within in privacy.css — keyboard focus reveals it too). Desktop
// band + `privacy.v1` cap only (`usePrivacyLock`'s `enabled`); no provider / no cap / phone
// band ⇒ nothing renders (byte-level zero trace). The ask_user needsAnswer badge is NOT
// gated on the lock (plan: 卡片保留 needsAnswer 徽标,内容解锁后才可见).
// ---------------------------------------------------------------------------
const privacy = inject(PRIVACY_LOCK_CTX, null);
const privacyMarked = computed(() => privacy?.isMarked(props.card.key) ?? false);
const privacyAffordance = computed(
  () => privacy !== null && privacy.enabled.value && privacy.sessionIdOf(props.card.key) !== null,
);
const privacyError = computed(() => {
  const err = privacy?.actionError.value;
  return err !== null && err !== undefined && err.agentKey === props.card.key ? err : null;
});

/** The affordance click: marked ⇒ open the 取消标记 dialog; unmarked ⇒ 「隐私标记」 directly
 *  (locking is not a sensitive operation — no password, plan v2 评审 #2). `.prevent.stop` on
 *  the click keeps the enclosing <a> from navigating. */
function onPrivacyClick(): void {
  if (privacy === null) return;
  if (privacyMarked.value) privacy.requestUnmark(props.card.key);
  else void privacy.mark(props.card.key);
}

// web-hub-spawn SP12 (arch §9.1): a non-terminal spawn record managing this card's agent adds
// the `web` badge — same inject channel as needsAnswer (the frozen props stay untouched).
const managed = computed(() => managedFor(hub?.state.value.spawns ?? null, props.card.key));
// spawn-restore plan §9.1: the OLD card of a restore in flight (F20 brief reconnect) shows
// `restoring`; a freshly restored card shows `restored` for the stability window.
const restoring = computed(() => restoringKeys(hub?.state.value.spawns ?? null).has(props.card.key));
const restored = computed(() => managed.value !== undefined && isFreshlyRestored(managed.value));

const dotClass = computed(() => {
  switch (props.card.visualState) {
    case "running":
      return "dot-live";
    case "stale":
      return "dot-dashed";
    case "idle":
    case "offline":
      return "dot-hollow";
    default:
      return undefined;
  }
});

// Badge placement: the chips group stays after the path while path + chips fit on row 1;
// otherwise it moves (Teleport — still ONE DOM node, one aria tree) to the session-name line.
// Measurements are placement-independent (title's natural width, the chips' intrinsic width,
// the 1fr column's width), so moving the group can never feed back into the decision.
const mainEl = ref<HTMLElement | null>(null);
const titleEl = ref<HTMLElement | null>(null);
const chipsEl = ref<HTMLElement | null>(null);
const belowEl = ref<HTMLElement | null>(null);
const chipsBelow = ref(false);

function measure(): void {
  const main = mainEl.value;
  const title = titleEl.value;
  const chips = chipsEl.value;
  if (!main || !title || !chips) return;
  const gap = Number.parseFloat(getComputedStyle(main).columnGap) || 0;
  chipsBelow.value = title.scrollWidth + gap + chips.offsetWidth > main.clientWidth;
}

const stops: Array<() => void> = [];
onMounted(() => {
  measure();
  for (const el of [mainEl.value, chipsEl.value]) if (el) stops.push(observeResize(el, measure));
});
onBeforeUnmount(() => {
  for (const stop of stops.splice(0)) stop();
});
watch(
  () => props.card.shortCwd,
  () => void nextTick(measure),
);

const kindLabel = computed(() => (props.card.kind === "rpc" ? "RPC" : "TUI"));
</script>

<template>
  <a
    class="agent-card"
    :href="`#/agent/${encodeURIComponent(card.key)}`"
    :aria-current="selected ? 'page' : undefined"
    :data-st="card.visualState"
  >
    <span class="agent-row1">
      <span class="dot" :class="dotClass"></span>
      <span ref="mainEl" class="agent-main">
        <span ref="titleEl" class="agent-title" translate="no" :title="card.cwdFull || card.shortCwd"
          ><bdi>{{ card.shortCwd }}</bdi></span
        >
        <Teleport :to="belowEl ?? 'body'" :disabled="!chipsBelow || !belowEl">
          <span ref="chipsEl" class="agent-chips">
            <span class="chip" translate="no">{{ kindLabel }}</span>
            <span v-if="card.visualState === 'offline'" class="chip chip-stopped" translate="no">
              {{ t("agents.stopped") }}
            </span>
            <span v-if="managed" class="chip chip-web" translate="no" :title="t('spawn.badgeWebTitle')">
              {{ t("spawn.badgeWeb") }}
            </span>
            <span v-if="restoring" class="chip chip-restoring" translate="no" :title="t('spawn.badgeRestoringTitle')">
              {{ t("spawn.badgeRestoring") }}
            </span>
            <span v-else-if="restored" class="chip chip-restored" translate="no" :title="t('spawn.badgeRestoredTitle')">
              {{ t("spawn.badgeRestored") }}
            </span>
            <span v-if="managed?.removing" class="chip chip-removing" translate="no">
              {{ t("agents.removing") }}
            </span>
            <span
              v-else-if="xsBadge"
              class="chip chip-xs"
              role="img"
              :data-xs="xsBadge"
              :title="t(`agents.xs.${xsBadge}`)"
              :aria-label="t(`agents.xs.${xsBadge}`)"
            >
              <AppIcon :name="XS_ICON[xsBadge]" />
            </span>
            <span
              v-if="xsChannels"
              class="chip chip-xs-channels"
              translate="no"
              :title="t('agents.xsChannels', { list: xsChannels.map((c) => '#' + c).join(' ') })"
              >{{ xsChannels.map((c) => "#" + c).join(" ") }}</span
            >
            <span
              v-if="xsUnread !== undefined"
              class="chip chip-xs-unread"
              role="img"
              translate="no"
              :title="t('agents.xsUnread', { n: xsUnread })"
              :aria-label="t('agents.xsUnread', { n: xsUnread })"
            >
              <AppIcon name="inbox" /><span class="num">{{ xsUnreadLabel(xsUnread) }}</span>
            </span>
          </span>
        </Teleport>
      </span>
      <span class="agent-end">
        <!-- web-hub-privacy P2: 锁定态常显 / 未锁定悬停显示 (privacy.css keys the reveal off
           `data-marked`). The click never navigates the card's <a>. -->
        <button
          v-if="privacyAffordance"
          type="button"
          class="privacy-lock-btn"
          :data-marked="privacyMarked ? 'true' : 'false'"
          :aria-label="privacyMarked ? t('privacy.unmarkTitle') : t('privacy.markAria')"
          :title="privacyMarked ? `${t('privacy.badgeMarked')} — ${t('privacy.unmarkTitle')}` : t('privacy.mark')"
          @click.prevent.stop="onPrivacyClick"
        >
          <AppIcon :name="privacyMarked ? 'lock' : 'unlock'" class="icon-sm" />
        </button>
        <span class="agent-cost num" :title="card.costTitle">{{ card.costLabel }}</span>
      </span>
    </span>
    <span v-if="privacyError" class="privacy-card-error" role="alert">
      {{ t(privacyError.key, { code: privacyError.code }) }}
    </span>

    <span class="agent-line2" :data-below="chipsBelow ? 'true' : 'false'">
      <span
        class="agent-session"
        :class="{ mono: card.sessionLabel === t('agents.noSessionName') }"
        translate="no"
        :title="card.sessionLabel"
        >{{ card.sessionLabel }}</span
      >
      <!-- the chips group is teleported here (same single DOM node) when row 1 cannot hold it -->
      <span ref="belowEl" class="agent-below"></span>
    </span>

    <span
      v-if="
        card.modelShort ||
        card.contextPercent !== null ||
        card.runningSubCount > 0 ||
        card.runningBashCount > 0 ||
        card.statusLabel
      "
      class="agent-meta"
    >
      <span v-if="card.modelShort" class="model" translate="no">{{ card.modelShort }}</span>
      <span v-if="card.modelShort && card.contextPercent !== null" class="sep" aria-hidden="true">·</span>
      <span v-if="card.contextPercent !== null">
        <meter
          class="meter"
          min="0"
          max="100"
          low="70"
          high="85"
          optimum="0"
          :value="card.contextPercent"
          :aria-label="t('detail.contextAria')"
        ></meter
        ><span class="num">{{ formatPercent(card.contextPercent, i18n.lang === "zh" ? "zh-CN" : "en-US") }}</span>
      </span>
      <template v-if="card.runningSubCount > 0">
        <span v-if="card.modelShort || card.contextPercent !== null" class="sep" aria-hidden="true">·</span>
        <span
          ><AppIcon name="branch" class="icon-sm" /><span class="num">{{
            t("agents.runningCount", { n: card.runningSubCount })
          }}</span></span
        >
      </template>
      <!-- 2026-10-15 会话列表也展示运行中的命令:terminal 图标 + 同一段 agents.runningCount
           文案(图标区分 agent/命令);仅统计 status.bashJobs 的非终态行(含 staged)。 -->
      <template v-if="card.runningBashCount > 0">
        <span
          v-if="card.modelShort || card.contextPercent !== null || card.runningSubCount > 0"
          class="sep"
          aria-hidden="true"
          >·</span
        >
        <span
          ><AppIcon name="terminal" class="icon-sm" /><span class="num">{{
            t("agents.runningCount", { n: card.runningBashCount })
          }}</span></span
        >
      </template>
      <template v-if="card.statusLabel">
        <span
          v-if="
            card.modelShort || card.contextPercent !== null || card.runningSubCount > 0 || card.runningBashCount > 0
          "
          class="sep"
          aria-hidden="true"
          >·</span
        >
        <span class="pill pill-inline" :data-st="card.visualState">
          <AppIcon v-if="card.visualState === 'waiting'" name="message" class="icon-sm" />
          <AppIcon v-else-if="card.visualState === 'offline'" name="unplug" class="icon-sm" />
          <AppIcon v-else-if="card.outdated" name="info" class="icon-sm" />
          {{ card.statusLabel }}
        </span>
      </template>
    </span>

    <span v-if="needsAnswer" class="agent-flags">
      <span v-if="needsAnswer" class="pill badge-answer">
        <AppIcon name="message" class="icon-sm" />{{ t("common.needsAnswer") }}
      </span>
    </span>
  </a>
</template>
