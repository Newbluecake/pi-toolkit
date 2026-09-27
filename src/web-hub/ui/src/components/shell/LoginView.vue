<!--
  Password (LAN) sign-in form (ui-design.md §6.7, §8, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/shell/**`). Purely declarative over `usePasswordAuth`'s (P1) state —
  clears the password field itself right after emitting `submit` (never held onto after that,
  matching the legacy `render/login.js` behavior `tests/web-hub/ui/login-view.test.ts` pins).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { LoginViewEmits, LoginViewProps } from "../../contracts.js";
import type { Notice } from "../../types.js";
import NoticeBanner from "./NoticeBanner.vue";

const props = defineProps<LoginViewProps>();
const emit = defineEmits<LoginViewEmits>();
const { t } = useI18n();

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
    <div class="login-card">
      <div class="login-brand">
        <span class="brand-mark" aria-hidden="true"><AppIcon name="logo" /></span>
        <h1 translate="no">pi web-hub</h1>
        <p>{{ t("login.subtitle") }}</p>
      </div>

      <NoticeBanner v-if="plaintext" :notice="plaintextNotice" />
      <NoticeBanner v-if="initialPasswordHint" :notice="initialPasswordNotice" />

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

      <div class="login-foot">
        <span>{{ t("common.readonly") }}</span>
      </div>
    </div>
  </main>
</template>
