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

  alias-plan r4 §7.1 (ALU): with the hub's `xs.alias.v1` cap (and the session's `status.xs`
  slot) the dialog gains an alias section on top and the title switches to 「频道与别名」;
  WITHOUT the cap every rendered byte is the pre-alias shape. Alias ops (`/fabric alias …`) go
  through `useTrackedCommand` — own cmdId, async settle via pendingCtl + ONE queryOnly,
  `E_CONFIRM_REQUIRED` re-issued with a NEW id + `confirm:true` behind the generic
  CommandConfirm bar, 15 s per wire flight, cancelled on timeout/dialog close/session switch.
  Take-over: the preview output of THIS command is the only token source
  (`parseTakeConfirm` on its last line) — the confirm box shows that output verbatim (holder's
  cwd label + offline duration) plus the token's remaining lifetime, and only then sends
  `--take=<token>`. No optimistic update anywhere: the echo plus the following status push
  (`status.xs.alias`) is the truth.
-->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref } from "vue";
import { normalizeAlias, parseTakeConfirm } from "@protocol/xs-alias.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useTicker } from "../../composables/useTicker.js";
import { useTrackedCommand, type TrackedCommandResult } from "../../composables/useTrackedCommand.js";
import { registerAliasExtra } from "../../i18n/alias-extra.js";
import { registerChannelsExtra } from "../../i18n/channels-extra.js";
import {
  aliasSuggestions,
  XS_ALIAS_CAP,
  XS_DEFAULT_CHANNEL,
  xsAliasOf,
  xsChannelsOf,
  type AliasSuggestion,
} from "../agents/agentCardModel.js";
import {
  channelCommandArgs,
  channelDirectory,
  checkNewChannel,
  XS_MAX_CHANNELS,
  type ChannelRow,
} from "../agents/channelModel.js";
import CommandConfirm from "../control/CommandConfirm.vue";
import { CONTROL_VIEW, HUB_CTX } from "../control/controlContext.js";
import PickerSheet from "../control/PickerSheet.vue";

const emit = defineEmits<{ close: [] }>();
registerChannelsExtra(); // before any t() this dialog renders
registerAliasExtra();
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

// ---------------------------------------------------------------------------
// alias-plan r4 §7.1 (ALU) — the alias section (cap-gated; absent ⇒ byte-identical above)
// ---------------------------------------------------------------------------

const aliasOn = computed(() => {
  const c = caps.value;
  if (!Array.isArray(c) || !c.includes(XS_ALIAS_CAP)) return false;
  const xs = (view?.agent.value.status as { xs?: unknown } | undefined)?.xs;
  return typeof xs === "object" && xs !== null;
});
const dialogTitle = computed(() => (aliasOn.value ? t("alias.dialogTitle") : t("channels.dialogTitle")));
const currentAlias = computed(() => (aliasOn.value ? xsAliasOf(view?.agent.value, caps.value) : undefined));

const tracked = useTrackedCommand({
  view: () => {
    if (view === null) return null;
    return {
      control: view.control,
      agentKey: view.agentKey,
      pendingCtl: view.agent.value.pendingCtl,
    };
  },
});
const trackedPhase = tracked.phase;
const trackedConfirm = tracked.confirmReq;
const aliasBusy = computed(() => trackedPhase.value !== "idle");

const aliasDraft = ref("");
const aliasCheck = computed(() => (aliasDraft.value.trim() === "" ? null : normalizeAlias(aliasDraft.value)));
const aliasValid = computed(() => (aliasCheck.value?.ok === true ? aliasCheck.value.alias : null));
const ALIAS_HINT_KEY = {
  invalid: "hintInvalid",
  too_long: "hintTooLong",
  id_like: "hintIdLike",
  reserved: "hintReserved",
} as const;
const aliasHint = computed(() => {
  const c = aliasCheck.value;
  if (c === null || c.ok) return null;
  return t(`alias.${ALIAS_HINT_KEY[c.reason]}`);
});
const suggestions = computed<readonly AliasSuggestion[]>(() =>
  aliasOn.value ? aliasSuggestions(view?.agent.value, hub?.state.value.agents, caps.value) : [],
);

const aliasNote = ref<{ kind: "ok" | "err"; text?: string; output?: string } | null>(null);

function showAliasResult(r: TrackedCommandResult): void {
  if (r.ok) {
    aliasNote.value =
      r.output !== "" ? { kind: "ok", output: r.output } : { kind: "ok", text: t("alias.doneFallback") };
    return;
  }
  if ("cancelled" in r) {
    aliasNote.value = null; // cancelled by timeout/close/switch — the status push is the truth
    return;
  }
  aliasNote.value = { kind: "err", text: t("channels.failed", { reason: r.message ?? r.error }) };
}

const canSaveAlias = computed(
  () => aliasValid.value !== null && !aliasBusy.value && aliasValid.value !== currentAlias.value,
);
const canTakeAlias = computed(() => aliasValid.value !== null && !aliasBusy.value);

async function onAliasSave(): Promise<void> {
  const a = aliasValid.value;
  if (a === null || !canSaveAlias.value) return;
  takePreview.value = null;
  showAliasResult(await tracked.run("fabric", `alias ${a}`));
}

async function onAliasClear(): Promise<void> {
  if (currentAlias.value === undefined || aliasBusy.value) return;
  takePreview.value = null;
  showAliasResult(await tracked.run("fabric", "alias --clear"));
}

// --- take-over (Q5/§3.5): preview → token ONLY from this command's own output → confirm → execute

/** §3.5: a take preview token lives 5 minutes (hub-side memory only). The wire echo carries no
 *  expiresAt, so the countdown below is the local 5-minute clock from the preview's arrival. */
const TAKE_TOKEN_TTL_MS = 5 * 60_000;
const takePreview = ref<{ alias: string; token: string; text: string; receivedAt: number } | null>(null);
const ticker = useTicker({
  doc: typeof document === "undefined" ? { hidden: false, addEventListener() {}, removeEventListener() {} } : document,
  win: typeof window === "undefined" ? { addEventListener() {}, removeEventListener() {} } : window,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  now: () => Date.now(),
});
onUnmounted(() => ticker.dispose());

const takeExpired = computed(
  () => takePreview.value !== null && ticker.now.value >= takePreview.value.receivedAt + TAKE_TOKEN_TTL_MS,
);
const takeRemaining = computed(() => {
  const p = takePreview.value;
  if (p === null) return "0:00";
  const s = Math.max(0, Math.ceil((p.receivedAt + TAKE_TOKEN_TTL_MS - ticker.now.value) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});

async function onAliasTake(): Promise<void> {
  const a = aliasValid.value;
  if (a === null || !canTakeAlias.value) return;
  takePreview.value = null;
  const r = await tracked.run("fabric", `alias ${a} --take`);
  if (!r.ok) {
    showAliasResult(r);
    return;
  }
  const parsed = parseTakeConfirm(r.output);
  if (parsed === undefined) {
    showAliasResult(r); // e.g. holder online / not held — the handler's echo explains
    return;
  }
  aliasNote.value = null;
  takePreview.value = { alias: parsed.alias, token: parsed.token, text: r.output, receivedAt: Date.now() };
}

async function onAliasTakeConfirm(): Promise<void> {
  const p = takePreview.value;
  if (p === null || takeExpired.value || aliasBusy.value) return;
  takePreview.value = null;
  showAliasResult(await tracked.run("fabric", `alias ${p.alias} --take=${p.token}`));
}
</script>

<template>
  <PickerSheet :label="dialogTitle" class="channels-scrim" @close="emit('close')">
    <div class="channels-dialog">
      <header class="channels-head">
        <h3 class="channels-title">{{ dialogTitle }}</h3>
        <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('channels.close')" @click="emit('close')">
          <AppIcon name="x" class="icon-sm" />
        </button>
      </header>

      <!-- alias-plan r4 §7.1 (ALU): the alias section — rendered ONLY under hub cap xs.alias.v1
           (+ the session's status.xs slot); without it every byte above/below is unchanged. -->
      <section v-if="aliasOn" class="alias-section" :aria-label="t('alias.sectionAria')">
        <p class="channels-new-label alias-section-head">
          {{ t("alias.sectionTitle") }}
          <span v-if="currentAlias !== undefined" class="alias-current" translate="no">{{
            t("alias.currentAlias", { alias: currentAlias })
          }}</span>
        </p>
        <form class="channels-new alias-new" @submit.prevent="void onAliasSave()">
          <label class="channels-new-label" for="alias-input">{{ t("alias.inputLabel") }}</label>
          <div class="channels-new-row">
            <input
              id="alias-input"
              v-model="aliasDraft"
              class="input"
              type="text"
              name="alias-name"
              autocomplete="off"
              spellcheck="false"
              maxlength="64"
              :placeholder="t('alias.inputPlaceholder')"
              :disabled="aliasBusy"
              :aria-invalid="aliasHint !== null ? 'true' : undefined"
              :aria-describedby="aliasHint !== null ? 'alias-hint' : undefined"
            />
            <button
              class="btn btn-primary btn-xs"
              type="submit"
              :disabled="!canSaveAlias"
              :aria-label="t('alias.saveAria')"
            >
              {{ t("alias.save") }}
            </button>
          </div>
          <p v-if="aliasHint !== null" id="alias-hint" class="channels-hint" role="alert">{{ aliasHint }}</p>
        </form>
        <div
          v-if="suggestions.length > 0"
          class="alias-suggestions"
          role="group"
          :aria-label="t('alias.suggestionsAria')"
        >
          <button
            v-for="s in suggestions"
            :key="s.alias"
            type="button"
            class="chip chip-muted alias-sugg"
            translate="no"
            :data-taken="s.taken ? 'true' : undefined"
            :title="s.taken ? t('alias.takenTitle') : undefined"
            :disabled="aliasBusy"
            @click="aliasDraft = s.alias"
          >
            @{{ s.alias }}
          </button>
        </div>
        <div class="alias-actions">
          <button
            v-if="currentAlias !== undefined"
            class="btn btn-ghost btn-xs"
            type="button"
            :disabled="aliasBusy"
            :aria-label="t('alias.clearAria')"
            @click="void onAliasClear()"
          >
            {{ t("alias.clear") }}
          </button>
          <button
            class="btn btn-ghost btn-xs"
            type="button"
            :disabled="!canTakeAlias"
            :aria-label="t('alias.takeAria')"
            @click="void onAliasTake()"
          >
            {{ t("alias.take") }}
          </button>
        </div>

        <!-- policy confirm (webCommandPolicy.fabric:"confirm"): the generic bar; 确认 re-issues
             with a NEW cmdId + confirm:true inside useTrackedCommand. -->
        <CommandConfirm
          v-if="trackedConfirm"
          :name="trackedConfirm.name"
          :args="trackedConfirm.args"
          @confirm="tracked.confirm()"
          @cancel="tracked.cancel()"
        />

        <!-- take-over confirm: the preview text is THIS preview command's own captured output
             (holder cwd label + offline duration); the token never leaves it. -->
        <div
          v-if="takePreview"
          class="alias-take-confirm"
          role="group"
          :aria-label="t('alias.takeConfirmTitle', { alias: takePreview.alias })"
        >
          <p class="alias-take-title">{{ t("alias.takeConfirmTitle", { alias: takePreview.alias }) }}</p>
          <pre class="alias-take-preview" translate="no" :aria-label="t('alias.previewAria')">{{
            takePreview.text
          }}</pre>
          <p class="channels-hint" role="status">
            {{ takeExpired ? t("alias.takeExpired") : t("alias.takeExpires", { t: takeRemaining }) }}
          </p>
          <div class="alias-actions">
            <button class="btn btn-ghost btn-xs" type="button" @click="takePreview = null">
              {{ t("dialog.cancel") }}
            </button>
            <button
              class="btn btn-primary btn-xs alias-take-run"
              type="button"
              :disabled="takeExpired || aliasBusy"
              @click="void onAliasTakeConfirm()"
            >
              {{ t("alias.takeConfirmRun") }}
            </button>
          </div>
        </div>

        <p v-if="trackedPhase === 'running'" class="channels-status" role="status">
          <AppIcon name="loader" class="icon-sm spin" />{{ t("channels.pending") }}
        </p>
        <template v-else-if="aliasNote !== null">
          <pre
            v-if="aliasNote.output !== undefined"
            class="channels-status alias-output"
            translate="no"
            :data-kind="aliasNote.kind"
            role="status"
            >{{ aliasNote.output }}</pre>
          <p
            v-else
            class="channels-status"
            :data-kind="aliasNote.kind"
            :role="aliasNote.kind === 'err' ? 'alert' : 'status'"
          >
            {{ aliasNote.text }}
          </p>
        </template>
      </section>

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
