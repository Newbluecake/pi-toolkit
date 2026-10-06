<!--
  Token-mode gate: an invalid/expired sign-in link, or an auth mode `App.vue` couldn't
  determine at all (ui-design.md §8, §9, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/shell/**`).
-->
<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { TokenGateProps } from "../../contracts.js";
import EmptyState from "./EmptyState.vue";

defineProps<TokenGateProps>();
const { t } = useI18n();

function reload(): void {
  window.location.reload();
}
</script>

<template>
  <main class="login-page">
    <div v-if="reason === 'token-invalid'" class="login-card login-card--center">
      <EmptyState
        icon="key"
        :title="t('login.tokenInvalidTitle')"
        :body="`${t('login.tokenInvalidLead')} /webhub ${t('login.tokenInvalidTail')}`"
      />
    </div>
    <div v-else class="login-card login-card--center">
      <div class="notice notice--danger" role="alert">
        <AppIcon name="alert" />
        <span class="notice-body">{{ t("notices.authUnknown") }}</span>
        <button class="btn notice-action" type="button" @click="reload">{{ t("notices.reload") }}</button>
      </div>
    </div>
  </main>
</template>
