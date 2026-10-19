<!--
LAN security r2 §3.2 (package D) — settings 「登录会话」 card, approved layout 1B
(~/pwh-preview/lan-security.html): one card per LAN login session, the current device first and
highlighted with a 「本设备」 chip, per-card 「下线」, and a two-step armed 「下线其他所有设备」.

P0 contract: the ONLY prop is the frozen `LanSessionsHandle`. The cap/auth-mode gate lives in
the composable (`phase === "unsupported"` ⇒ render nothing); I mounts this card unconditionally
inside SettingsView. The session-* class names mirror the approved preview; the matching
stylesheet block is part of the wiring request (styles/ is outside package D's allowlist), and
every structural class used here (`settings-card`/`settings-h`/`settings-note`/`chip`/`btn`/
`btn-ghost`/`btn-danger`/`notice*`) already exists globally, so the card is functional without it.

No v-html, no style= attributes, no <style> block (source-scan rules). All times come from the
wire (ms since epoch); 最近活跃 is relative (「刚刚」/「n 分钟前」/…, re-rendered by the 30 s
ticker) and 登录时间 absolute via the shared `formatDateTime`.
-->
<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import type { LanSessionWire } from "@protocol/lan-sessions.js";
import { useI18n } from "../../composables/useI18n.js";
import { useArmedConfirm } from "../../composables/useArmedConfirm.js";
import { useTicker } from "../../composables/useTicker.js";
import type { LanSessionsHandle } from "../../composables/useLanSessions.js";
import { formatDateTime, localeFor } from "../../format.js";
import { userAgentLabel } from "../../logic/userAgent.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{ sessions: LanSessionsHandle }>();

const i18n = useI18n();
const { t } = i18n;

const ticker = useTicker({
  doc: document,
  win: window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  now: () => Date.now(),
  intervalMs: 30_000,
});
onUnmounted(() => ticker.dispose());

const phase = computed(() => props.sessions.phase.value);
const snapshot = computed(() => props.sessions.snapshot.value);
const lastRevoke = computed(() => props.sessions.lastRevoke.value);
const visible = computed(() => phase.value !== "unsupported");
const loading = computed(() => phase.value === "idle" || phase.value === "loading");
/** phase "error" = the LAST operation failed. With a snapshot still present that was a revoke
 * (or a post-revote re-list); without one it was the initial load. */
const loadFailed = computed(() => phase.value === "error" && snapshot.value === undefined);
const revokeFailed = computed(() => phase.value === "error" && snapshot.value !== undefined);
const revoking = ref(false);
const working = computed(() => loading.value || revoking.value);
async function revoke(body: Parameters<LanSessionsHandle["revoke"]>[0]): Promise<void> {
  if (working.value) return;
  revoking.value = true;
  try {
    await props.sessions.revoke(body);
  } finally {
    revoking.value = false;
  }
}
/** A revoke-others that already succeeded leaves exactly one session (this device). */
const canRevokeOthers = computed(() => (snapshot.value?.sessions.length ?? 0) > 1);

function deviceLabel(s: LanSessionWire): string {
  return userAgentLabel(s.ua) || t("sessions.unknownDevice");
}
function absoluteTime(ms: number): string {
  return formatDateTime(ms, localeFor(i18n.lang));
}
function relativeActive(ms: number): string {
  const diff = Math.max(0, ticker.now.value - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("sessions.justNow");
  if (minutes < 60) return t("sessions.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("sessions.hoursAgo", { n: hours });
  return absoluteTime(ms);
}

const revokeOthers = useArmedConfirm(() => {
  void revoke({ others: true });
});

function onRevoke(id: string): void {
  void revoke({ id });
}
function onRefresh(): void {
  void props.sessions.refresh();
}
</script>

<template>
  <section
    v-if="visible"
    class="settings-card settings-card-wide settings-sessions-card"
    :aria-label="t('sessions.title')"
    :aria-busy="loading"
  >
    <div class="sessions-meta">
      <h2 class="settings-h">{{ t("sessions.title") }}</h2>
      <span v-if="snapshot" class="chip sessions-count">{{ snapshot.sessions.length }} / {{ snapshot.max }}</span>
      <button
        type="button"
        class="btn btn-icon sessions-refresh"
        :disabled="working"
        :aria-label="t('sessions.refresh')"
        @click="onRefresh"
      >
        <AppIcon name="refresh" />
      </button>
    </div>
    <p v-if="snapshot" class="settings-note">
      {{ t("sessions.hint", { idle: snapshot.idleMinutes, days: snapshot.absoluteDays }) }}
    </p>

    <p v-if="loading && !snapshot" class="settings-note sessions-status" role="status">{{ t("sessions.loading") }}</p>
    <div v-else-if="loadFailed" class="notice notice--danger" role="alert">
      <span class="notice-body">{{ t("sessions.errorLoad") }}</span>
      <button type="button" class="btn notice-action" @click="onRefresh">{{ t("sessions.retry") }}</button>
    </div>

    <template v-if="snapshot">
      <div class="sessions-cards">
        <article
          v-for="s in snapshot.sessions"
          :key="s.id"
          class="session-card"
          :class="{ 'session-card--current': s.current }"
        >
          <div class="session-card-top">
            <span class="sess-device"><AppIcon name="monitor" class="sess-device-icon" />{{ deviceLabel(s) }}</span>
            <span v-if="s.current" class="chip chip-current">{{ t("sessions.currentDevice") }}</span>
            <button v-else type="button" class="btn btn-ghost" :disabled="working" @click="onRevoke(s.id)">
              {{ t("sessions.revoke") }}
            </button>
          </div>
          <dl class="session-card-meta">
            <dt>{{ t("sessions.colIp") }}</dt>
            <dd class="sess-mono">{{ s.lastIp ?? s.createdIp }}</dd>
            <dt>{{ t("sessions.colLogin") }}</dt>
            <dd>{{ absoluteTime(s.createdAt) }}</dd>
            <dt>{{ t("sessions.colMethod") }}</dt>
            <dd>
              {{
                t(`sessions.method${(s.method ?? "password")[0]!.toUpperCase()}${(s.method ?? "password").slice(1)}`)
              }}
            </dd>
            <dt>{{ t("sessions.colActive") }}</dt>
            <dd>{{ relativeActive(s.lastSeenAt) }}</dd>
          </dl>
        </article>
      </div>

      <div v-if="revokeFailed" class="notice notice--danger" role="alert">
        <span class="notice-body">{{ t("sessions.errorRevoke") }}</span>
        <button type="button" class="btn notice-action" @click="onRefresh">{{ t("sessions.retry") }}</button>
      </div>
      <div v-else-if="lastRevoke && !lastRevoke.complete" class="notice notice--warn" role="status">
        <span class="notice-body">{{ t("sessions.revokedPartial", { n: lastRevoke.revoked }) }}</span>
      </div>
      <div v-else-if="lastRevoke" class="notice notice--muted" role="status">
        <span class="notice-body">{{ t("sessions.revokedOk", { n: lastRevoke.revoked }) }}</span>
      </div>
      <div class="notice notice--muted notice--boxed sessions-cap-note">
        <span class="notice-body">{{ t("sessions.capNote", { max: snapshot.max }) }}</span>
      </div>

      <div class="sessions-foot">
        <button
          type="button"
          class="btn btn-danger sessions-revoke-others"
          :disabled="!canRevokeOthers || working"
          :aria-label="revokeOthers.armed.value ? t('sessions.revokeOthersArmed') : t('sessions.revokeOthers')"
          @click="revokeOthers.trigger"
          @keydown="revokeOthers.onKeydown"
        >
          {{ revokeOthers.armed.value ? t("sessions.revokeOthersArmed") : t("sessions.revokeOthers") }}
        </button>
      </div>
    </template>
  </section>
</template>
