<!--
  Two-step delete button (web-hub-delete-session plan v2 §5.4, §0.1 #3): a small icon button
  rendered as a SIBLING of `AgentCard`/`SpawnRow` — never nested inside `AgentCard`'s `<a>`
  (buttons can't nest inside anchors, and the frozen `AgentCardProps` stays untouched). First
  click arms (4s auto-disarm, Esc disarms — same grammar as `DetailHeader.vue`'s 「停止会话」),
  the second click within the window calls `hub.removeAgent(target)`. No optimistic removal
  (§5.4 「不做乐观删除」): the card only disappears once the hub's `agent_removed`/`spawns`
  broadcast actually lands — this component only tracks its OWN busy/armed/failed presentation.
  `removing` (server-confirmed in-flight delete, from `@logic/remove.js`'s target) disables the
  button and shows a loader independent of this tab's own `busy` flag — another tab's delete
  (or this one's own 202 pending state) must freeze the button identically everywhere.
-->
<script setup lang="ts">
import { inject, onUnmounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { classifyRemoveError } from "../../logic/remove.js";
import type { RemoveTarget } from "../../types.js";
import { HUB_CTX } from "../control/controlContext.js";
import "../../styles/agents.css";

const props = defineProps<{
  readonly target: RemoveTarget;
  readonly removing: boolean;
  readonly ariaKind: "agent" | "managed" | "spawn";
}>();
const { t } = useI18n();
const hub = inject(HUB_CTX, null);

const ARIA_KEYS = {
  agent: "agents.removeAria",
  managed: "agents.removeManagedAria",
  spawn: "spawn.removeAria",
} as const;

const ARM_MS = 4000;
const FAIL_MS = 6000;

const armed = ref(false);
const busy = ref(false);
const failKind = ref<string | null>(null);
let armTimer: ReturnType<typeof setTimeout> | undefined;
let failTimer: ReturnType<typeof setTimeout> | undefined;

function clearFail(): void {
  failKind.value = null;
  if (failTimer !== undefined) {
    clearTimeout(failTimer);
    failTimer = undefined;
  }
}

function disarm(): void {
  armed.value = false;
  if (armTimer !== undefined) {
    clearTimeout(armTimer);
    armTimer = undefined;
  }
}

function showFail(kind: string): void {
  failKind.value = kind;
  failTimer = setTimeout(clearFail, FAIL_MS);
}

async function onClick(): Promise<void> {
  if (props.removing || busy.value) return;
  if (!armed.value) {
    clearFail();
    armed.value = true;
    armTimer = setTimeout(disarm, ARM_MS);
    return;
  }
  disarm();
  const removeAgent = hub?.removeAgent;
  if (removeAgent === undefined) {
    showFail("unsupported");
    return;
  }
  busy.value = true;
  clearFail();
  try {
    const outcome = await removeAgent(props.target);
    if (!outcome.ok) showFail(classifyRemoveError(outcome) ?? "network");
  } finally {
    busy.value = false;
  }
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && armed.value) {
    ev.stopPropagation();
    disarm();
  }
}

onUnmounted(() => {
  disarm();
  clearFail();
});
</script>

<template>
  <span class="remove-wrap">
    <button
      class="btn btn-ghost remove-btn"
      :class="{ armed, busy: busy || removing }"
      type="button"
      :disabled="busy || removing"
      :aria-label="armed ? t('agents.removeConfirm') : t(ARIA_KEYS[ariaKind])"
      @click="onClick"
      @keydown="onKeydown"
    >
      <AppIcon v-if="busy || removing" name="loader" class="icon-sm spin" />
      <AppIcon v-else name="x" class="icon-sm" />
    </button>
    <p v-if="removing" class="remove-note" role="status">{{ t("agents.removing") }}</p>
    <p v-else-if="failKind" class="remove-note" role="status">
      {{ t("agents.removeFailed", { reason: t(`agents.removeErr.${failKind}`) }) }}
    </p>
  </span>
</template>
