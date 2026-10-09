<!--
  Persistent control risk notice (control-plan.md v2.1 §7.4/§7.6 — C5), COLLAPSIBLE to a
  one-line summary (native `<details>`) and, per the 2026 "全部可关" decision, dismissible too —
  every variant now carries a close (×) button. The two lower-risk variants (local full-machine
  control; password behind an HTTPS-terminating proxy) remember a dismissal across sessions via
  `localStorage`, keyed by variant name (`webhub.controlNotice.dismissed.<variant>`). The
  highest-risk variant — password auth over plain HTTP, where anyone sniffing this network's
  traffic can hijack the session — only remembers the dismissal for the current browser
  session (`sessionStorage`, same key prefix): a NEW session re-shows it, which is the one
  piece of the old "never closable" contract this build deliberately keeps as a last-resort
  reminder for the most dangerous access mode. 2026-10 explicit user opt-out: the browser pref
  `pwh_hide_plaintext_warn` (`composables/usePlaintextWarning.ts` — the sole LAN user accepts
  the plaintext risk) drops ONLY the plaintext sentence from the plainHttp body
  (`control.noticePlainHttpMasked` keeps the control-risk remainder); the notice itself — title,
  expand, dismissal, risk-scaled storage memory — keeps rendering.
  Copy variant (§7.6): token mode ⇒ local;
  password over plaintext HTTP ⇒ plainHttp; password behind an HTTPS-terminating proxy ⇒ https.
  The expanded state is shared (`CONTROL_ENV.noticeExpanded`) so the TopBar Control chip opens
  the same notice (§7.4) — dismissal is independent of that shared expanded flag: the TopBar
  chip's own click handler only flips `noticeExpanded`. 2026-10-09 (「我不想经常看到这个提示」/
  「作为终端图标的点击效果」): a dismissed notice comes BACK, expanded, while the chip holds
  `noticeExpanded` true (× closes it again, dismissal kept) — the chip is the way to re-read it;
  and with the plaintext opt-out pref set, the plainHttp dismissal persists in localStorage.
-->
<script setup lang="ts">
import { computed, getCurrentInstance, inject, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import type { ControlNoticeProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";
import { browserLocalStorage } from "../shell/themeStorage.js";
import { CONTROL_ENV } from "./controlContext.js";

const props = defineProps<ControlNoticeProps>();
const { t } = useI18n();

const env = inject(CONTROL_ENV, null);

// Vue Boolean-casts absent optional props to `false`, so an explicit `:plaintext="false"` and
// "prop not passed" are indistinguishable via `props` alone — `vnode.props` key presence is the
// tri-state escape hatch (env fills in only when the caller said nothing).
const vnodeProps = getCurrentInstance()?.vnode.props ?? {};

const variant = computed<"plainHttp" | "https" | "local">(() => {
  const mode = props.mode ?? env?.authMode ?? "token";
  const plaintext = "plaintext" in vnodeProps ? props.plaintext === true : (env?.plaintext ?? false);
  if (mode === "password") return plaintext ? "plainHttp" : "https";
  return "local";
});

// The explicit browser opt-out (`pwh_hide_plaintext_warn`): when the pref hides plaintext
// warnings, the plainHttp body swaps to the masked copy — the control-risk remainder ("this
// page can send messages to your agents and stop them") stays visible.
const warn = usePlaintextWarning({ storage: browserLocalStorage() });

const bodyKey = computed(() => {
  if (variant.value === "plainHttp" && warn.hidden.value) return "control.noticePlainHttpMasked";
  return { plainHttp: "control.noticePlainHttp", https: "control.noticeHttps", local: "control.noticeLocal" }[
    variant.value
  ];
});

const localOpen = ref(false);
const open = computed({
  get: () => env?.noticeExpanded.value ?? localOpen.value,
  set: (v: boolean) => {
    if (env) env.noticeExpanded.value = v;
    else localOpen.value = v;
  },
});

function onToggle(ev: Event): void {
  open.value = (ev.target as HTMLDetailsElement).open;
}

// --- dismiss (per variant, §7.6 risk-scaled memory) -----------------------------------------
function dismissKey(v: string): string {
  return `webhub.controlNotice.dismissed.${v}`;
}

/** `plainHttp` is the one variant that only remembers the dismissal for this browser session
 * (anyone sniffing plaintext HTTP traffic is the highest-risk scenario this notice covers) —
 * UNLESS the user explicitly opted out of plaintext warnings (`pwh_hide_plaintext_warn`,
 * 2026-10-09 「我不想经常看到这个提示」): then it remembers the dismissal like the others. */
function storageFor(v: string): Storage | null {
  try {
    return v === "plainHttp" && !warn.hidden.value ? window.sessionStorage : window.localStorage;
  } catch {
    return null; // storage can throw in locked-down/private-mode browsers — fail open (show it)
  }
}

function readDismissed(v: string): boolean {
  return storageFor(v)?.getItem(dismissKey(v)) === "1";
}

const dismissed = ref(readDismissed(variant.value));
watch([variant, () => warn.hidden.value], ([v]) => {
  dismissed.value = readDismissed(v);
});

/** 2026-10-09 「控制已开启这个提示可以作为终端图标的点击效果」: once dismissed, the TopBar
 * terminal chip (which flips the shared `noticeExpanded`) brings the notice back, expanded —
 * the chip is the way to read it again; × closes it again without forgetting the dismissal. */
const visible = computed(() => !dismissed.value || open.value);

function onDismiss(): void {
  open.value = false;
  dismissed.value = true;
  try {
    storageFor(variant.value)?.setItem(dismissKey(variant.value), "1");
  } catch {
    // best-effort persistence only — the in-memory `dismissed` flag above already took effect
  }
}
</script>

<template>
  <details v-if="visible" class="control-notice" :open="open" @toggle="onToggle">
    <summary>
      <AppIcon name="alert" class="icon-sm" />
      <span class="notice-title">{{ t("control.noticeTitle") }}</span>
      <span class="notice-toggle">{{ open ? t("control.noticeCollapse") : t("control.noticeExpand") }}</span>
      <button
        class="btn btn-ghost btn-icon notice-dismiss"
        type="button"
        :aria-label="t('control.noticeDismiss')"
        @click.stop.prevent="onDismiss"
      >
        <AppIcon name="x" class="icon-sm" />
      </button>
    </summary>
    <p class="notice-body">{{ t(bodyKey) }}</p>
  </details>
</template>
