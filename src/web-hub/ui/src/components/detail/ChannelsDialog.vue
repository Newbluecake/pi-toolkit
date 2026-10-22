<!--
  ChannelsDialog (channel-plan §7 「频道管理弹窗」, CHU) — LAZY: mounted by DetailHeader through
  `defineAsyncComponent` on first open. Shell: `PickerSheet.vue` (scrim click / Esc close, Tab trap,
  focus return, scroll lock).

  Data: the hub's channel directory is derived client-side from every session's pushed
  `status.xs.channels` (absent ∧ joined ⇒ [default]; `channelModel.ts`) — no protocol change.
  Actions: toggling a row / creating a channel sends the web command `/fabric join #x` /
  `/fabric leave #x` through `ControlHandle.runCommand` (same `cmd{op:"command"}` channel as the
  header's clear button; `webCommandPolicy.fabric` and the Feishu hard refusal apply on the agent
  side). NO optimistic update: the checkmarks follow `status.xs.channels` only; the dialog shows
  in-flight / failure text and one request at a time.
-->
<script setup lang="ts">
import { computed, inject, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { registerChannelsExtra } from "../../i18n/channels-extra.js";
import { XS_DEFAULT_CHANNEL, xsChannelsOf } from "../agents/agentCardModel.js";
import {
  channelCommandArgs,
  channelDirectory,
  checkNewChannel,
  XS_MAX_CHANNELS,
  type ChannelRow,
} from "../agents/channelModel.js";
import { CONTROL_VIEW, HUB_CTX } from "../control/controlContext.js";
import PickerSheet from "../control/PickerSheet.vue";

const emit = defineEmits<{ close: [] }>();
registerChannelsExtra(); // before any t() this dialog renders
const { t } = useI18n();

const view = inject(CONTROL_VIEW, null);
const hub = inject(HUB_CTX, null);

const caps = computed(() => hub?.state.value.hub?.["caps"]);
const joined = computed<readonly string[]>(() => xsChannelsOf(view?.agent.value, caps.value) ?? []);
const rows = computed<readonly ChannelRow[]>(() => {
  const agents = hub?.state.value.agents;
  const dir = agents instanceof Map ? channelDirectory(agents, caps.value) : [];
  // a channel this session sits in always lists, even when the directory has not caught up
  const names = new Set(dir.map((r) => r.name));
  const extra = joined.value.filter((c) => !names.has(c)).map((name) => ({ name, members: 1 }));
  return [...dir, ...extra];
});
const full = computed(() => joined.value.length >= XS_MAX_CHANNELS);

const pending = ref<string | null>(null);
const note = ref<{ kind: "ok" | "err"; text: string } | null>(null);
const draft = ref("");

const check = computed(() => (draft.value.trim() === "" ? null : checkNewChannel(draft.value, joined.value)));
const hint = computed(() => {
  const c = check.value;
  if (c === null || c.ok) return null;
  if (c.reason === "empty") return null;
  const key = { invalid: "hintInvalid", reserved: "hintReserved", joined: "hintJoined", full: "hintFull" }[c.reason];
  return t(`channels.${key}`, { n: XS_MAX_CHANNELS });
});
const canCreate = computed(() => check.value?.ok === true && pending.value === null);

async function run(verb: "join" | "leave", name: string): Promise<void> {
  const c = view?.control ?? null;
  if (c === null || view === null || pending.value !== null) return;
  pending.value = name;
  note.value = null;
  try {
    const outcome = await c.runCommand(view.agentKey, "fabric", channelCommandArgs(verb, name));
    note.value = outcome.ok
      ? { kind: "ok", text: t("channels.sent") }
      : { kind: "err", text: t("channels.failed", { reason: outcome.message ?? outcome.error ?? "E_FAILED" }) };
    if (outcome.ok && verb === "join") draft.value = "";
  } catch {
    note.value = { kind: "err", text: t("channels.failed", { reason: "E_NETWORK" }) };
  } finally {
    pending.value = null;
  }
}

function onToggle(row: ChannelRow): void {
  void run(joined.value.includes(row.name) ? "leave" : "join", row.name);
}
function rowDisabled(row: ChannelRow): boolean {
  if (pending.value !== null) return true;
  return !joined.value.includes(row.name) && full.value;
}
function onCreate(): void {
  const c = check.value;
  if (c !== null && c.ok && pending.value === null) void run("join", c.name);
}
</script>

<template>
  <PickerSheet :label="t('channels.dialogTitle')" class="channels-scrim" @close="emit('close')">
    <div class="channels-dialog">
      <header class="channels-head">
        <h3 class="channels-title">{{ t("channels.dialogTitle") }}</h3>
        <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('channels.close')" @click="emit('close')">
          <AppIcon name="x" class="icon-sm" />
        </button>
      </header>

      <ul class="channels-list" role="group" :aria-label="t('channels.listAria')">
        <li v-for="(row, i) in rows" :key="row.name" class="channels-row" :data-joined="joined.includes(row.name)">
          <label class="channels-label">
            <input
              type="checkbox"
              class="channels-check"
              :data-autofocus="i === 0 ? '' : undefined"
              :checked="joined.includes(row.name)"
              :disabled="rowDisabled(row)"
              @change="onToggle(row)"
            />
            <span class="channels-name" translate="no">#{{ row.name }}</span>
            <span class="channels-count num">{{ t("channels.members", { n: row.members }) }}</span>
            <AppIcon v-if="pending === row.name" name="loader" class="icon-sm spin" />
          </label>
          <p v-if="row.name === XS_DEFAULT_CHANNEL && joined.includes(row.name)" class="channels-note">
            {{ t("channels.defaultLeaveNote") }}
          </p>
        </li>
        <li v-if="rows.length === 0" class="channels-empty">{{ t("channels.empty") }}</li>
      </ul>

      <p v-if="full" class="channels-hint" role="status">{{ t("channels.fullHint", { n: XS_MAX_CHANNELS }) }}</p>

      <form class="channels-new" @submit.prevent="onCreate">
        <label class="channels-new-label" for="channels-new-input">{{ t("channels.newLabel") }}</label>
        <div class="channels-new-row">
          <input
            id="channels-new-input"
            v-model="draft"
            class="input"
            type="text"
            name="channel-name"
            autocomplete="off"
            spellcheck="false"
            maxlength="40"
            :placeholder="t('channels.newPlaceholder')"
            :disabled="full || pending !== null"
            :aria-invalid="hint !== null ? 'true' : undefined"
            :aria-describedby="hint !== null ? 'channels-new-hint' : undefined"
          />
          <button class="btn btn-primary btn-xs" type="submit" :disabled="!canCreate">
            {{ t("channels.newAction") }}
          </button>
        </div>
        <p v-if="hint !== null" id="channels-new-hint" class="channels-hint" role="alert">{{ hint }}</p>
      </form>

      <p v-if="pending !== null" class="channels-status" role="status">
        <AppIcon name="loader" class="icon-sm spin" />{{ t("channels.pending") }}
      </p>
      <p
        v-else-if="note !== null"
        class="channels-status"
        :data-kind="note.kind"
        :role="note.kind === 'err' ? 'alert' : 'status'"
      >
        {{ note.text }}
      </p>
    </div>
  </PickerSheet>
</template>
