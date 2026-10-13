<!--
  Privacy lock screen (web-hub-privacy plan v2.1, package P2 — 「客户端行为」). Mounted by
  `DashboardView.vue` IN PLACE OF the whole `<AgentDetail>` subtree while the viewed session
  is privacy-marked and not view-unlocked (P0: 锁定会话不挂载 AgentDetail). Renders ONLY the
  session title, the lock icon, and the unlock zone — no transcript, panels, dock, composer
  or dialog content.

  Two variants (plan 评审 #7 (a) / v2.1 N1):
  - **password (LAN)**: password field + 解锁 button → `privacy.verify`. A wrong password is
    the `200 {ok:false}` verdict (`errors.invalid`); a 429 rides the login-style
    `errors.throttled` countdown (`error.countdownS`, the button stays disabled while busy) —
    the same copy/UX the sign-in form uses.
  - **token (loopback)**: no second credential exists, so the unlock zone is a single
    「点击确认查看」 button plus an honesty hint — never a fake password box.

  Pure presentation: the parent (`DashboardView`) owns `usePrivacyLock` and the verify call;
  this component only emits `unlock`. The password field is cleared right after emitting
  (never held onto, mirroring `LoginView.vue`).
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { LoginErrorView } from "../../types.js";

const props = defineProps<{
  /** The session's display title (name / sessionId prefix) — the ONLY session fact shown. */
  readonly title: string;
  readonly mode: "token" | "password";
  readonly busy: boolean;
  readonly error: LoginErrorView | null;
}>();
const emit = defineEmits<{ unlock: [password: string | null] }>();
const { t } = useI18n();

const password = ref("");
const showPassword = ref(false);
const passwordEl = ref<HTMLInputElement | null>(null);
const confirmEl = ref<HTMLButtonElement | null>(null);

// Focus enters the unlock zone on mount: the lock screen can replace AgentDetail at any moment
// (timeout / tab-hide / another tab's mark), dropping the previously focused element with the
// unmounted subtree — keyboard users land on the password box (LAN) / confirm button (loopback)
// instead of <body>.
onMounted(async () => {
  await nextTick();
  (props.mode === "password" ? passwordEl.value : confirmEl.value)?.focus();
});

const errorText = computed(() => {
  if (props.error === null) return "";
  const params = {
    ...(props.error.params ?? {}),
    ...(props.error.countdownS === undefined ? {} : { s: props.error.countdownS }),
  };
  return t(props.error.key, params);
});

function onSubmit(): void {
  if (props.busy) return;
  const value = password.value;
  password.value = ""; // cleared immediately — never held after the attempt (LoginView parity)
  emit("unlock", value);
}

function onConfirmView(): void {
  if (props.busy) return;
  emit("unlock", null);
}
</script>

<template>
  <div class="privacy-lock" role="region" :aria-label="t('privacy.screenTitle')">
    <div class="privacy-lock-card">
      <span class="privacy-lock-icon" aria-hidden="true"><AppIcon name="lock" /></span>
      <h2 class="privacy-lock-title">{{ t("privacy.screenTitle") }}</h2>
      <p class="privacy-lock-session" translate="no">{{ title }}</p>
      <p class="privacy-lock-body">{{ t("privacy.screenBody") }}</p>

      <form v-if="mode === 'password'" class="form privacy-lock-form" novalidate @submit.prevent="onSubmit">
        <div class="field">
          <label for="privacy-unlock-password">{{ t("privacy.passwordLabel") }}</label>
          <div class="input-wrap">
            <input
              id="privacy-unlock-password"
              ref="passwordEl"
              v-model="password"
              class="input"
              name="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              autocapitalize="none"
              spellcheck="false"
              :disabled="busy"
            />
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              :aria-label="showPassword ? t('login.hidePassword') : t('login.showPassword')"
              :aria-pressed="showPassword"
              @click="showPassword = !showPassword"
            >
              <AppIcon name="eye" />
            </button>
          </div>
        </div>
        <p class="form-error" role="alert">{{ errorText }}</p>
        <button class="btn btn-primary" type="submit" :disabled="busy">{{ t("privacy.unlockSubmit") }}</button>
      </form>

      <template v-else>
        <button
          ref="confirmEl"
          class="btn btn-primary privacy-lock-confirm"
          type="button"
          :disabled="busy"
          @click="onConfirmView"
        >
          {{ t("privacy.confirmView") }}
        </button>
        <p class="privacy-lock-hint">{{ t("privacy.loopbackHint") }}</p>
        <p v-if="errorText" class="form-error" role="alert">{{ errorText }}</p>
      </template>
    </div>
  </div>
</template>
