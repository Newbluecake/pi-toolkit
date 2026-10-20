<!--
  Inline ONE-click confirmation for `E_CONFIRM_REQUIRED` commands (control-plan.md v2.1
  §4.6/§7.7 — C5; redesigned 2026-10-20 per user ruling + approved mock
  ~/pwh-preview/cmdconfirm/cmd-confirm.png): the old arm/4s-revert second click is gone —
  one click on 「执行」 emits `confirm` (the dock then re-issues `runCommand` with a NEW id and
  `confirm: true`; §4.6: confirmation is UX anti-misclick, not a security boundary), `cancel`
  drops the pending command. Enter anywhere in the bar = confirm (a focused 取消 button still
  activates itself), Esc = cancel. The 执行 button is auto-focused on appear UNLESS focus is
  inside the composer (never steal typing focus), and focus is handed back to the previously
  focused element (falling back to the composer textarea) on confirm/cancel/unmount. The
  server's raw English `message` prop is
  kept for the DetailDock contract but NEVER rendered — the description always comes from the
  i18n map below (generic fallback for unknown commands). Session-replacing commands
  (new/clear/resume/fork) get the danger variant: red accent + red 执行.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";

const props = defineProps<{
  readonly name: string;
  readonly args: string;
  readonly message?: string | undefined;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();

/** Commands that REPLACE the current session — danger styling (ruling point 2). */
const SESSION_REPLACING: ReadonlySet<string> = new Set(["new", "clear", "resume", "fork"]);

/**
 * Commands with an i18n description (`control.cmdDesc.<name>`, zh+en parity) and a tile icon;
 * every other command falls back to `control.cmdDesc.generic` + the alert glyph. The keys mirror
 * every `confirm`-capable command in `src/web-hub/agent/command-policy.ts` (builtins new/reload/
 * compact/resume-by-override; pi-toolkit table agent/mem/cache-ttl/tasklist/goal/task/watch/
 * feishu-test/clear; extension-fallback topic-switch/webhub).
 */
const KNOWN: Readonly<Record<string, IconName>> = {
  reload: "refresh",
  new: "file",
  clear: "file",
  resume: "swap",
  fork: "branch",
  compact: "layers",
  agent: "gear",
  "cache-ttl": "clock",
  mem: "inbox",
  webhub: "monitor",
  goal: "radio",
  "topic-switch": "swap",
  watch: "eye",
  task: "bot",
  tasklist: "check",
  "feishu-test": "message",
};

const danger = computed(() => SESSION_REPLACING.has(props.name));
const icon = computed<IconName>(() => KNOWN[props.name] ?? "alert");
const commandLabel = computed(() => `/${props.name}${props.args !== "" ? ` ${props.args}` : ""}`);
// `props.message` deliberately never read here — see the header comment.
const description = computed(() =>
  t(KNOWN[props.name] !== undefined ? `control.cmdDesc.${props.name}` : "control.cmdDesc.generic"),
);

const runBtn = ref<HTMLButtonElement | null>(null);

/** Focused element captured when the bar appears — focus is handed back to it (or, when it
 *  left the DOM meanwhile, to the composer textarea) on confirm/cancel/Esc/unmount. */
let previousFocus: HTMLElement | null = null;

function restoreFocus(): void {
  const target =
    previousFocus !== null && previousFocus.isConnected
      ? previousFocus
      : typeof document === "undefined"
        ? null
        : document.querySelector<HTMLElement>(".composer textarea");
  target?.focus();
}

onMounted(() => {
  previousFocus =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Auto-focus 执行 so Enter confirms immediately — but never steal focus out of the
  // composer textarea while the user is typing (ruling point 1).
  if (previousFocus !== null && previousFocus.closest(".composer") !== null) return;
  runBtn.value?.focus();
});

// Parent-driven unmounts (re-dispatch, session switch): hand focus back only while the bar
// still owns it — if the user moved focus elsewhere meanwhile, never yank it back.
onBeforeUnmount(() => {
  const current = typeof document === "undefined" ? null : document.activeElement;
  if (
    current instanceof HTMLElement &&
    runBtn.value !== null &&
    runBtn.value.closest(".command-confirm")?.contains(current)
  )
    restoreFocus();
});

function onConfirm(): void {
  emit("confirm");
  restoreFocus();
}

function onCancel(): void {
  emit("cancel");
  restoreFocus();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    onCancel();
    return;
  }
  if (ev.key === "Enter") {
    // A focused 取消 button activates itself on Enter (cancel stays cancel); Enter anywhere
    // else in the bar means confirm. preventDefault suppresses the 执行 button's native
    // keydown-activation click so `confirm` is emitted exactly once.
    if (ev.target instanceof HTMLElement && ev.target.closest(".command-confirm-cancel") !== null) return;
    ev.preventDefault();
    ev.stopPropagation();
    onConfirm();
  }
}
</script>

<template>
  <div
    class="command-confirm"
    :class="{ danger }"
    role="group"
    :aria-label="t('control.cmdConfirmAria', { cmd: commandLabel })"
    @keydown="onKeydown"
  >
    <span class="command-confirm-icon" aria-hidden="true"><AppIcon :name="icon" class="icon-sm" /></span>
    <span class="command-confirm-body">
      <span class="command-confirm-title">
        {{ t("control.cmdConfirmDo") }}
        <code class="command-confirm-code" translate="no">{{ commandLabel }}</code>
        {{ t("control.cmdConfirmQ") }}
      </span>
      <span class="command-confirm-desc" :title="description">{{ description }}</span>
    </span>
    <span class="command-confirm-actions">
      <button class="btn btn-ghost command-confirm-cancel" type="button" @click="onCancel">
        {{ t("dialog.cancel") }}
      </button>
      <button
        ref="runBtn"
        class="btn command-confirm-run"
        :class="danger ? 'btn-danger' : 'btn-primary'"
        type="button"
        @click="onConfirm"
      >
        {{ t("control.cmdConfirmRun") }}
      </button>
    </span>
  </div>
</template>
