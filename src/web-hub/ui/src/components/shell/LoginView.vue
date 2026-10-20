<!--
  Password (LAN) sign-in form (ui-design.md §6.7, §8, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/shell/**`). Purely declarative over `usePasswordAuth`'s (P1) state —
  clears the password field itself right after emitting `submit` (never held onto after that,
  matching the legacy `render/login.js` behavior `tests/web-hub/ui/login-view.test.ts` pins).
-->
<script setup lang="ts">
import { computed, ref, onUnmounted } from "vue";
import LoginSecondFactor from "./LoginSecondFactor.vue";
import { useTicker } from "../../composables/useTicker.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import type { LoginViewEmits, LoginViewProps } from "../../contracts.js";
import type { Notice } from "../../types.js";
import NoticeBanner from "./NoticeBanner.vue";
import { browserLocalStorage } from "./themeStorage.js";

const props = defineProps<LoginViewProps>();
const emit = defineEmits<LoginViewEmits>();
const { t } = useI18n();
const factorVisible = computed(() => props.secondFactorEnabled === true && props.challenge != null);
const ticker = useTicker({
  doc: document,
  win: window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  now: () => Date.now(),
});
onUnmounted(() => {
  ticker.dispose();
  if (factorVisible.value) emit("factorCancel");
});

// `pwh_hide_plaintext_warn` (explicit browser opt-out, set from the authenticated settings
// panel — localStorage survives the sign-out) gates the plaintext-HTTP sign-in banner.
const warn = usePlaintextWarning({ storage: browserLocalStorage() });
const showPlainNotice = computed(() => warn.warnVisible(props.plaintext));

const username = ref("");
const password = ref("");
const showPassword = ref(false);

const plaintextNotice = computed<Notice>(() => ({
  id: "plaintext-http",
  tone: "warn",
  title: t("login.plaintextLead"),
  body: `${t("login.plaintextBody")} ${t("login.plaintextMore")}`,
  persistent: true,
}));

const initialPasswordNotice = computed<Notice>(() => ({
  id: "initial-password-hint",
  tone: "warn",
  title: t("notices.initialPasswordLead"),
  body: t("notices.initialPasswordMore"),
  persistent: true,
}));

const errorText = computed(() => {
  if (!props.error) return "";
  const params = {
    ...(props.error.params ?? {}),
    ...(props.error.countdownS === undefined ? {} : { s: props.error.countdownS }),
  };
  return t(props.error.key, params);
});

function onSubmit(): void {
  const payload = { username: username.value, password: password.value };
  password.value = "";
  emit("submit", payload);
}
</script>

<template>
  <main class="login-page">
    <template v-if="factorVisible && challenge">
      <LoginSecondFactor
        :challenge="challenge"
        :busy="busy"
        :now="ticker.now.value"
        v-bind="{
          ...(attemptsLeft === undefined ? {} : { attemptsLeft }),
          ...(lockedUntil === undefined ? {} : { lockedUntil }),
        }"
        @submit="emit('factorSubmit', $event)"
        @wait="emit('factorWait')"
        @cancel="emit('factorCancel')"
      />
      <p v-if="errorText" class="form-error" role="alert">{{ errorText }}</p>
    </template>
    <div v-else class="login-card">
      <div class="login-brand">
        <span class="brand-mark" aria-hidden="true"><AppIcon name="logo" /></span>
        <h1 translate="no">pi web-hub</h1>
        <p>{{ t("login.subtitle") }}</p>
      </div>

      <div v-if="showPlainNotice || initialPasswordHint" class="login-notices">
        <NoticeBanner v-if="showPlainNotice" :notice="plaintextNotice" />
        <NoticeBanner v-if="initialPasswordHint" :notice="initialPasswordNotice" />
      </div>

      <form class="form" novalidate @submit.prevent="onSubmit">
        <div class="field">
          <label for="login-username">{{ t("login.usernameLabel") }}</label>
          <input
            id="login-username"
            v-model="username"
            class="input"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            required
            :disabled="busy"
          />
        </div>
        <div class="field">
          <label for="login-password">{{ t("login.passwordLabel") }}</label>
          <div class="input-wrap">
            <input
              id="login-password"
              v-model="password"
              class="input"
              name="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              autocapitalize="none"
              spellcheck="false"
              required
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
        <button class="btn btn-primary btn-lg" type="submit" :disabled="busy">{{ t("login.submit") }}</button>
      </form>

      <!-- 2026-10-20: the 「只读」 chip that lived here dated from the read-only P1 hub and no longer
           said anything true (control is on). The empty foot stays: on phones its margin-top:auto
           balances the form's, keeping the form optically centered. -->
      <div class="login-foot" aria-hidden="true"></div>
    </div>
  </main>
</template>
