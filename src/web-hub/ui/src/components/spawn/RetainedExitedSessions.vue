<!-- Current hub records, not history files or synthetic agent cards. No IO on mount. -->
<script setup lang="ts">
import { computed, inject } from "vue";
import { HUB_CTX } from "../control/controlContext.js";
import { RETAINED_RELAUNCH } from "../../composables/useRetainedRelaunch.js";
import { useI18n } from "../../composables/useI18n.js";
import { retainedRecoveryRows, restoreFailureKey } from "../../logic/spawn.js";

const hub = inject(HUB_CTX, null);
const retained = inject(RETAINED_RELAUNCH, null);
const { t } = useI18n();
const rows = computed(() => {
  const records = hub?.state.value.spawns;
  const terminal = retainedRecoveryRows(records, hub?.state.value.hub?.["caps"]);
  return [
    ...terminal,
    ...(records?.items.filter((r) => r.state === "starting" && retained?.pending.value.has(r.spawnId)) ?? []),
  ].sort((a, b) => b.updatedAt - a.updatedAt || (a.spawnId < b.spawnId ? -1 : a.spawnId > b.spawnId ? 1 : 0));
});
const detachedErrors = computed(() =>
  [...(retained?.errors.value ?? [])].filter(([id]) => !rows.value.some((r) => r.spawnId === id)),
);
const flowBusy = computed(() => {
  const phase = hub?.spawn?.newSession.flow?.value.phase;
  return phase === "submitting" || phase === "confirming" || phase === "awaiting";
});
function isoTime(at: number): string | undefined {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}
function displayTime(at: number): string {
  return isoTime(at) === undefined ? "—" : new Date(at).toLocaleString();
}
</script>

<template>
  <section class="history-retained" :aria-label="t('history.retainedTitle')">
    <h4 class="history-retained-title">{{ t("history.retainedTitle") }}</h4>
    <p class="history-note">{{ t("history.retainedBudget") }}</p>
    <p class="history-note">{{ t("history.retainedVerify") }}</p>
    <p v-if="hub?.spawn?.newSession.flow?.value.phase === 'submitting'" class="history-status" role="status">
      {{ t("spawn.pickerSubmitting") }}
    </p>
    <p v-if="rows.length === 0" class="history-note">{{ t("history.retainedEmpty") }}</p>
    <ul v-else class="history-retained-list">
      <li v-for="rec in rows" :key="rec.spawnId" class="history-retained-row" :data-spawn-id="rec.spawnId">
        <div class="history-retained-line">
          <span class="history-retained-cwd" :title="rec.cwdLabel" translate="no"
            >{{ rec.cwdLabel }} · {{ rec.spawnId.slice(0, 8) }}</span
          >
          <span class="chip chip-mono" translate="no">{{
            rec.removing ? "removing" : rec.state === "failed" ? "restore failed" : rec.state
          }}</span>
          <button
            class="btn btn-ghost btn-xs"
            type="button"
            :disabled="!retained || rec.removing === true || retained.isPending(rec.spawnId) || flowBusy"
            @click="retained?.request(rec.spawnId)"
          >
            {{ retained?.isPending(rec.spawnId) ? t("spawn.relaunchPending") : t("history.retainedTry") }}
          </button>
        </div>
        <p class="history-note" translate="no">
          <time :datetime="isoTime(rec.updatedAt)">{{ displayTime(rec.updatedAt) }}</time>
          <span v-if="rec.endReason"> · {{ rec.endReason }}</span>
          <span v-if="rec.exit?.unconfirmed"> · unconfirmed</span>
        </p>
        <p v-if="retained?.errors.value.has(rec.spawnId)" class="history-session-error" role="alert">
          {{ t(retained.errors.value.get(rec.spawnId)!) }}
        </p>
        <p v-else-if="rec.state === 'failed'" class="history-note">
          {{ t(restoreFailureKey(rec.restore?.failure) ?? "history.retainedFailed") }}
        </p>
      </li>
    </ul>
    <p v-for="[id, key] in detachedErrors" :key="id" class="history-session-error" role="alert">{{ t(key) }}</p>
  </section>
</template>
