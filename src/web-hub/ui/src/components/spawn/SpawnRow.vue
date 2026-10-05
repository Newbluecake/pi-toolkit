<!--
  SpawnRow — a `starting` / `failed` placeholder row for the AGENTS list (web-hub-spawn plan
  SP12 / arch §9.1). Presentation + event forwarding over the SP11 surface; the row's model
  (`pendingRows`) is computed by the parent from the `spawns` SSE slot.

  - `starting` — spinner chip + `cwdLabel`, no actions (the record has no agentKey yet; arch
    §7.5 binding is hub-side).
  - `failed` — hint line (`SpawnHint` mapping, arch §8.1) plus:
      · 「详情」— fetches `useSpawn.list()` and shows the OWNER-only fields (`hintDetail`,
        `stderrTail`, arch §6.4) when this principal owns the record; otherwise an owner-only
        note. Everything renders through interpolation ⇒ textContent.
      · 「重试」— resolves the owner-only `cwd` from the same `list()` detail and resubmits via
        `useNewSession.submit({ cwd })` (a NEW id, §3.2 失败后重试); without owner visibility an
        inline note explains why nothing happened.
      · 「关闭」— emits `dismiss`; the parent drops the row from its local view (the hub keeps
        the terminal record until it rolls off `SPAWN_TERMINAL_KEEP`).
-->
<script setup lang="ts">
import { computed, inject, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { SpawnRecordPublic } from "@protocol/spawn.js";
import { HUB_CTX } from "../control/controlContext.js";
import "../../styles/spawn.css";

const props = defineProps<{ readonly rec: SpawnRecordPublic }>();
const emit = defineEmits<{ dismiss: [] }>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);

const HINT_KEYS: Record<string, string> = {
  "register-timeout-hello": "spawn.hintRegisterTimeoutHello",
  "register-timeout-session": "spawn.hintRegisterTimeoutSession",
  "control-off": "spawn.hintControlOff",
  "newer-plugin": "spawn.hintNewerPlugin",
  "cwd-mismatch": "spawn.hintCwdMismatch",
  "protocol-error": "spawn.hintProtocolError",
  "launcher-changed": "spawn.hintLauncherChanged",
};
const hintLabel = computed(() => {
  const hint = props.rec.hint;
  if (hint === undefined) return null;
  const key = HINT_KEYS[hint];
  return key !== undefined ? t(key) : hint;
});
const stateLabel = computed(() => (props.rec.state === "failed" ? t("spawn.stateFailed") : t("spawn.stateStarting")));

// ---------------------------------------------------------------------------
// owner detail (「详情」— GET /api/headless rides the owner projection, arch §6.4)
// ---------------------------------------------------------------------------
interface OwnerDetail {
  readonly cwd?: string;
  readonly hintDetail?: string;
  readonly stderrTail?: string;
}

const detailOpen = ref(false);
const detailBusy = ref(false);
const detailFailed = ref(false);
/** `undefined` = never fetched; `null` = fetched but not owner-visible; object = owner detail. */
const detail = ref<OwnerDetail | null | undefined>(undefined);

async function fetchDetail(): Promise<OwnerDetail | null> {
  if (detail.value !== undefined) return detail.value;
  const spawn = hub?.spawn;
  if (spawn === undefined) {
    detailFailed.value = true;
    return null;
  }
  detailBusy.value = true;
  detailFailed.value = false;
  try {
    const r = await spawn.list();
    if (!r.ok) {
      detailFailed.value = true;
      return null;
    }
    const found = r.items.find((it) => it.spawnId === props.rec.spawnId);
    if (found === undefined) {
      // The record already rolled off the hub's terminal retention — treat as not visible.
      detail.value = null;
      return null;
    }
    const peek = found as SpawnRecordPublic & {
      cwd?: unknown;
      hintDetail?: unknown;
      stderrTail?: unknown;
    };
    const owner: OwnerDetail = {
      ...(typeof peek.cwd === "string" ? { cwd: peek.cwd } : {}),
      ...(typeof peek.hintDetail === "string" ? { hintDetail: peek.hintDetail } : {}),
      ...(typeof peek.stderrTail === "string" ? { stderrTail: peek.stderrTail } : {}),
    };
    detail.value =
      owner.cwd === undefined && owner.hintDetail === undefined && owner.stderrTail === undefined ? null : owner;
    return detail.value;
  } catch {
    detailFailed.value = true;
    return null;
  } finally {
    detailBusy.value = false;
  }
}

async function onToggleDetail(): Promise<void> {
  detailOpen.value = !detailOpen.value;
  if (detailOpen.value) await fetchDetail();
}

// ---------------------------------------------------------------------------
// retry (§3.2 失败后重试 — owner cwd → new submit; the flow id is fresh by construction)
// ---------------------------------------------------------------------------
const retryBusy = ref(false);
const retryDenied = ref(false);

async function onRetry(): Promise<void> {
  const spawn = hub?.spawn;
  if (spawn === undefined || retryBusy.value) return;
  retryBusy.value = true;
  retryDenied.value = false;
  try {
    const owner = await fetchDetail();
    if (owner?.cwd === undefined) {
      retryDenied.value = true;
      return;
    }
    await spawn.newSession.submit({ cwd: owner.cwd });
  } finally {
    retryBusy.value = false;
  }
}
</script>

<template>
  <div class="spawn-row" :data-state="rec.state">
    <div class="spawn-row-line">
      <AppIcon v-if="rec.state === 'starting'" name="loader" class="icon-sm spin" />
      <AppIcon v-else name="alert" class="icon-sm" />
      <span class="chip chip-spawn" :data-state="rec.state" translate="no">{{ stateLabel }}</span>
      <span class="spawn-row-cwd" :title="rec.cwdLabel" translate="no">{{ rec.cwdLabel }}</span>
      <span v-if="rec.state === 'failed'" class="spawn-row-actions">
        <button
          class="btn btn-ghost btn-xs"
          type="button"
          :aria-label="t('spawn.rowDetailsAria', { cwd: rec.cwdLabel })"
          :disabled="detailBusy"
          @click="onToggleDetail"
        >
          {{ t("spawn.rowDetails") }}
        </button>
        <button
          class="btn btn-ghost btn-xs"
          type="button"
          :aria-label="t('spawn.rowRetryAria', { cwd: rec.cwdLabel })"
          :disabled="retryBusy"
          @click="onRetry"
        >
          {{ t("spawn.rowRetry") }}
        </button>
        <button
          class="btn btn-ghost btn-xs"
          type="button"
          :aria-label="t('spawn.rowDismissAria')"
          @click="emit('dismiss')"
        >
          {{ t("spawn.rowDismiss") }}
        </button>
      </span>
    </div>
    <p v-if="hintLabel" class="spawn-row-hint">{{ hintLabel }}</p>
    <p v-if="retryDenied" class="spawn-row-hint">{{ t("spawn.rowOwnerOnly") }}</p>
    <template v-if="detailOpen">
      <p v-if="detailFailed" class="spawn-row-hint">{{ t("spawn.rowDetailError") }}</p>
      <p v-else-if="detail === null" class="spawn-row-hint">{{ t("spawn.rowOwnerOnly") }}</p>
      <div v-else-if="detail">
        <p v-if="detail.hintDetail" class="spawn-picker-note">{{ detail.hintDetail }}</p>
        <template v-if="detail.stderrTail">
          <span class="spawn-field-label">{{ t("spawn.rowStderrTail") }}</span>
          <pre class="spawn-row-detail" translate="no">{{ detail.stderrTail }}</pre>
        </template>
      </div>
    </template>
  </div>
</template>
