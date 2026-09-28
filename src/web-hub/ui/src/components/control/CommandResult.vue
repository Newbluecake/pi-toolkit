<!--
  Command result echo (control-plan.md v2.1 §4.9 第 10 条, §7.7 — C5). Renders a
  `CommandOutputWire` as TEXT NODES ONLY (no `v-html`, no innerHTML — source-scan enforced):
  notify rows carry their level badge, widget/status group under their `key` subtitle, text and
  error entries are `<pre>` blocks; any `interactive` entries collapse into the needsTerminal
  line listing the skipped steps; a `truncated` footer reports dropped entries/bytes;
  `captured: false` (third-party extension command) shows the terminal-only note instead.
  `completion: "async"` renders as running until `cmd_late`/`queryOnly` resolves it (the dock
  re-fetches — SSE cmd_late never carries output, §6.6).
-->
<script setup lang="ts">
import { computed } from "vue";
import type { CommandOutputEntry, CommandOutputWire } from "@protocol/messages.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  readonly name: string;
  readonly state: "running" | "done" | "failed";
  readonly output?: CommandOutputWire | null | undefined;
  readonly captured?: boolean | undefined;
  readonly error?: string | undefined;
  readonly message?: string | undefined;
  /** §4.6: a non-ask_user `ui_prompt_start` within 2s of dispatch ⇒ the command is parked on a
   * terminal interaction (third-party commands only — pi-toolkit's own are degraded, §4.9). */
  readonly waitingTerminal?: boolean | undefined;
}>();
const emit = defineEmits<{ dismiss: [] }>();
const { t } = useI18n();

const entries = computed<readonly CommandOutputEntry[]>(() => props.output?.entries ?? []);

const interactiveSteps = computed(() =>
  entries.value.filter((e) => e.kind === "interactive").map((e) => e.title ?? e.text),
);

const visibleEntries = computed(() => entries.value.filter((e) => e.kind !== "interactive"));

const truncatedFooter = computed(() => {
  const tr = props.output?.truncated;
  if (!tr) return null;
  return t("control.cmdOutput.truncated", { entries: tr.droppedEntries, kib: Math.ceil(tr.droppedBytes / 1024) });
});

const showTerminalOnly = computed(
  () => props.state === "done" && props.captured === false && visibleEntries.value.length === 0,
);
</script>

<template>
  <div class="command-result" :data-state="state">
    <div class="command-result-head">
      <AppIcon name="terminal" class="icon-sm" />
      <b translate="no">/{{ name }}</b>
      <span v-if="state === 'running'" class="chip state-chip"
        ><AppIcon name="loader" class="icon-sm spin" />{{ t("control.cmdRunning") }}</span
      >
      <span v-else-if="state === 'failed'" class="chip state-chip" data-policy="deny">{{
        t("control.stateFailed")
      }}</span>
      <button
        class="btn btn-ghost btn-xs command-result-dismiss"
        type="button"
        :aria-label="t('control.discardAria')"
        @click="emit('dismiss')"
      >
        <AppIcon name="x" class="icon-sm" />
      </button>
    </div>

    <p v-if="waitingTerminal" class="command-waiting-terminal" role="status">
      <AppIcon name="monitor" class="icon-sm" />{{ t("control.cmdWaitingTerminal") }}
    </p>

    <p v-if="state === 'failed'" class="command-error" role="alert">
      {{ message ?? t("control.cmdFailed", { name, error: error ?? "E_FAILED" }) }}
    </p>

    <p v-else-if="showTerminalOnly" class="command-terminal-only">{{ t("control.cmdOutput.terminalOnly") }}</p>

    <div v-else-if="visibleEntries.length > 0" class="command-output">
      <template v-for="(entry, i) in visibleEntries" :key="i">
        <p v-if="entry.kind === 'notify'" class="output-notify">
          <span class="chip" :data-level="entry.level ?? 'info'">{{ entry.level ?? "info" }}</span>
          {{ entry.text }}
        </p>
        <div v-else-if="entry.kind === 'widget' || entry.kind === 'status'" class="output-block">
          <span v-if="entry.key" class="output-key" translate="no">{{ entry.key }}</span>
          <pre>{{ entry.text }}{{ entry.clipped === true ? t("control.cmdOutput.clipped") : "" }}</pre>
        </div>
        <pre v-else :class="{ 'output-error': entry.kind === 'error' }">{{
          entry.text + (entry.clipped === true ? t("control.cmdOutput.clipped") : "")
        }}</pre>
      </template>
    </div>

    <p v-if="interactiveSteps.length > 0" class="command-needs-terminal">
      {{ t("control.cmdOutput.needsTerminal", { steps: interactiveSteps.join(", ") }) }}
    </p>
    <p v-if="truncatedFooter !== null" class="command-truncated">{{ truncatedFooter }}</p>
  </div>
</template>
