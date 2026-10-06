<!--
  DirPicker — the 「选择目录新建…」 inline panel (web-hub-spawn plan SP12 / arch §9.1, plan
  §3.2). Renders the `useNewSession` (SP11) flow phases and forwards every user intent to that
  orchestrator — no wire calls, no verdicts of its own beyond the §8.2 48 KiB client-side
  precheck (the same `PROMPT_TEXT_MAX_BYTES` constant the protocol exports):

  - `idle` — the form: cwd input (prefilled with the selected agent's cwd or `~`), the
    `GET /api/headless/dirs` recent list, an optional first-prompt textarea.
  - `submitting` — form disabled, status line.
  - `confirming` — replaced by SpawnConfirm (409 `E_CONFIRM_REQUIRED`, arch §6.3).
  - `awaiting` / `unknown` — status lines; the first-prompt mirror rides along as `fp:*` chips.
  - `failed` — the §3.2 error taxonomy line (`classifySpawnError` kind → `spawn.err*`), inputs
    restored from `flow.input` (失败保留输入; `refilled:"picker"` returns the retained body the
    same way), Retry resubmits under a NEW id via `newSession.retry()`.
  - `done` — a success line and a `done` emit so the parent can close the panel.

  Rendered only while the parent holds it open; closing mid-`awaiting` never cancels the flow
  (SpawnRow keeps showing progress) — Escape only resolves a pending `confirming` first.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { DirEntryWire } from "@protocol/spawn.js";
import { PROMPT_TEXT_MAX_BYTES } from "@protocol/spawn.js";
import { HUB_CTX } from "../control/controlContext.js";
import type { NewSessionInput } from "../../types.js";
import SpawnConfirm from "./SpawnConfirm.vue";
import "../../styles/spawn.css";

const props = defineProps<{
  /** Selected agent's cwd, or `~` — the initial value of the directory input. */
  readonly prefillCwd?: string | undefined;
  /** Opened from the NewSessionMenu main button ⇒ focus 「启动」 so it's click-click-spawn. */
  readonly focusSubmit?: boolean;
  /** LAN plaintext HTTP — forwarded to SpawnConfirm's warning. */
  readonly plaintext?: boolean;
}>();
const emit = defineEmits<{
  /** User dismissed the panel (cancel button / Escape). In-flight flows keep running. */
  close: [];
  /** The flow reached `done` (session live, first prompt settled) — the parent may close. */
  done: [];
}>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const newSession = computed(() => hub?.spawn?.newSession ?? null);
const flow = computed(() => newSession.value?.flow.value ?? ({ phase: "idle" } as const));

// ---------------------------------------------------------------------------
// form state (local; restored from flow.input on failure — plan §3.2 保留输入)
// ---------------------------------------------------------------------------
const cwd = ref(props.prefillCwd ?? "~");
const firstPrompt = ref("");

const textEncoder = new TextEncoder();
const promptBytes = computed(() => textEncoder.encode(firstPrompt.value).length);
const promptTooLong = computed(() => promptBytes.value > PROMPT_TEXT_MAX_BYTES);

/** Restore the failed flow's input exactly once per reqId (a later edit is never clobbered). */
let restoredReqId: string | null = null;
watch(flow, (f) => {
  if (f.phase === "failed" && f.input !== undefined && f.reqId !== undefined && f.reqId !== restoredReqId) {
    restoredReqId = f.reqId;
    cwd.value = f.input.cwd;
    firstPrompt.value = f.input.firstPrompt?.text ?? "";
  }
  if (f.phase === "idle") restoredReqId = null;
  if (f.phase === "done") emit("done");
});

// ---------------------------------------------------------------------------
// recent directories (GET /api/headless/dirs — additive, errors degrade to a note)
// ---------------------------------------------------------------------------
const recent = ref<readonly DirEntryWire[]>([]);
const recentPartial = ref(false);
const recentFailed = ref(false);

onMounted(async () => {
  const spawn = hub?.spawn;
  if (props.focusSubmit === true) {
    await nextTick();
    submitBtn.value?.focus();
  }
  if (spawn === undefined) return;
  try {
    const r = await spawn.dirs();
    if (r.ok) {
      recent.value = r.recent;
      recentPartial.value = r.partial === true;
    } else {
      recentFailed.value = true;
    }
  } catch {
    recentFailed.value = true;
  }
});

function pickRecent(dir: DirEntryWire): void {
  cwd.value = dir.cwd;
}

// ---------------------------------------------------------------------------
// submit / retry / cancel — straight onto the SP11 orchestrator
// ---------------------------------------------------------------------------
const busyPhase = computed(() => {
  const p = flow.value.phase;
  return p === "submitting" || p === "awaiting" || p === "unknown" || p === "confirming";
});
const submitDisabled = computed(
  () => newSession.value === null || busyPhase.value || cwd.value.trim() === "" || promptTooLong.value,
);

const submitBtn = ref<HTMLButtonElement | null>(null);

function onSubmit(): void {
  const ns = newSession.value;
  if (ns === null || submitDisabled.value) return;
  const text = firstPrompt.value;
  const input: NewSessionInput = {
    cwd: cwd.value.trim(),
    ...(text !== "" ? { firstPrompt: { text } } : {}),
  };
  void ns.submit(input);
}

// --- failure presentation (§3.2 taxonomy; `spawn`/`first-prompt` are the flow-local kinds) ---
const ERR_KEYS: Record<string, string> = {
  dir: "spawn.errDir",
  denied: "spawn.errDenied",
  limit: "spawn.errLimit",
  rate: "spawn.errRate",
  launcher: "spawn.errLauncher",
  deadline: "spawn.errDeadline",
  network: "spawn.errNetwork",
  spawn: "spawn.errSpawn",
  "first-prompt": "spawn.errFirstPrompt",
  confirm: "spawn.errNetwork",
};
const HINT_KEYS: Record<string, string> = {
  "register-timeout-hello": "spawn.hintRegisterTimeoutHello",
  "register-timeout-session": "spawn.hintRegisterTimeoutSession",
  "control-off": "spawn.hintControlOff",
  "newer-plugin": "spawn.hintNewerPlugin",
  "cwd-mismatch": "spawn.hintCwdMismatch",
  "protocol-error": "spawn.hintProtocolError",
  "launcher-changed": "spawn.hintLauncherChanged",
};

const failure = computed(() => {
  const f = flow.value;
  return f.phase === "failed" ? f : null;
});
const failureText = computed(() => {
  const f = failure.value;
  if (f === null) return null;
  const key = ERR_KEYS[f.kind] ?? "spawn.errNetwork";
  return t(key);
});
const failureDetail = computed(() => {
  const f = failure.value;
  if (f === null) return null;
  if (f.hint !== undefined) {
    const key = HINT_KEYS[f.hint];
    if (key !== undefined) return t(key);
  }
  return f.message ?? f.code ?? null;
});
const failureRetryAfter = computed(() => {
  const f = failure.value;
  return f !== null && typeof f.retryAfterS === "number" ? f.retryAfterS : null;
});

function onRetry(): void {
  void newSession.value?.retry();
}

function onCancelOrClose(): void {
  const f = flow.value;
  if (f.phase === "confirming") newSession.value?.cancel();
  emit("close");
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  ev.stopPropagation();
  onCancelOrClose();
}
</script>

<template>
  <section v-if="newSession" class="spawn-picker" :aria-label="t('spawn.pickerAria')" @keydown="onKeydown">
    <template v-if="flow.phase === 'confirming'">
      <SpawnConfirm
        :resolved-cwd="flow.resolvedCwd"
        :reason="flow.reason"
        :plaintext="plaintext === true"
        @confirm="newSession.confirm()"
        @cancel="newSession.cancel()"
      />
    </template>

    <template v-else>
      <h3 class="spawn-picker-title">{{ t("spawn.pickerTitle") }}</h3>

      <div class="spawn-field">
        <label class="spawn-field-label" for="spawn-cwd">{{ t("spawn.pickerCwdLabel") }}</label>
        <input
          id="spawn-cwd"
          v-model="cwd"
          class="input"
          type="text"
          name="spawn-cwd"
          :placeholder="t('spawn.pickerCwdPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          :disabled="busyPhase"
        />
      </div>

      <div v-if="recent.length > 0" class="spawn-field">
        <span class="spawn-field-label">{{ t("spawn.pickerRecentLabel") }}</span>
        <div class="spawn-recent">
          <button
            v-for="dir in recent"
            :key="dir.cwd"
            class="btn btn-xs spawn-recent-btn"
            type="button"
            :title="dir.cwd"
            :disabled="busyPhase"
            @click="pickRecent(dir)"
          >
            <AppIcon name="folder" class="icon-sm" />{{ dir.label }}
          </button>
        </div>
        <p v-if="recentPartial" class="spawn-picker-note">{{ t("spawn.pickerRecentPartial") }}</p>
      </div>
      <p v-else-if="recentFailed" class="spawn-picker-note">{{ t("spawn.pickerRecentError") }}</p>

      <div class="spawn-field">
        <label class="spawn-field-label" for="spawn-first-prompt">{{ t("spawn.pickerPromptLabel") }}</label>
        <textarea
          id="spawn-first-prompt"
          v-model="firstPrompt"
          class="spawn-prompt-input"
          name="spawn-first-prompt"
          :placeholder="t('spawn.pickerPromptPlaceholder')"
          :disabled="busyPhase"
        ></textarea>
        <p v-if="promptTooLong" class="spawn-picker-error" role="alert">
          {{ t("spawn.pickerPromptTooLong", { n: promptBytes }) }}
        </p>
      </div>

      <p v-if="flow.phase === 'submitting'" class="spawn-picker-status" role="status">
        <AppIcon name="loader" class="icon-sm spin" />{{ t("spawn.pickerSubmitting") }}
      </p>
      <p v-else-if="flow.phase === 'awaiting'" class="spawn-picker-status" role="status">
        <AppIcon name="loader" class="icon-sm spin" />{{ t("spawn.pickerAwaiting") }}
        <span v-if="flow.firstPrompt" class="chip chip-spawn" translate="no">{{
          flow.firstPrompt.state === "sending" ? t("spawn.fpSending") : t("spawn.fpPending")
        }}</span>
      </p>
      <p v-else-if="flow.phase === 'unknown'" class="spawn-picker-status" role="status">
        {{ t("spawn.pickerUnknown") }}
      </p>
      <p v-else-if="flow.phase === 'done'" class="spawn-picker-status" role="status">{{ t("spawn.pickerDone") }}</p>

      <div v-if="failureText" class="spawn-picker-error" role="alert">
        <p class="spawn-picker-note">{{ failureText }}</p>
        <p v-if="failureDetail" class="spawn-picker-note">{{ failureDetail }}</p>
        <p v-if="failureRetryAfter !== null" class="spawn-picker-note">
          {{ t("spawn.errRetryAfter", { n: failureRetryAfter }) }}
        </p>
      </div>

      <div class="spawn-picker-actions">
        <button v-if="failure" class="btn btn-xs" type="button" @click="onRetry">{{ t("spawn.pickerRetry") }}</button>
        <button class="btn btn-ghost btn-xs" type="button" @click="onCancelOrClose">
          {{ busyPhase ? t("spawn.pickerClose") : t("spawn.pickerCancel") }}
        </button>
        <button
          ref="submitBtn"
          class="btn btn-primary btn-xs"
          type="button"
          :disabled="submitDisabled"
          @click="onSubmit"
        >
          {{ t("spawn.pickerSubmit") }}
        </button>
      </div>
    </template>
  </section>
</template>
