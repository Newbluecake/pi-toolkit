<script setup lang="ts">
import { registerTerminalV2Extra } from "../../../i18n/terminal-v2-extra.js";
registerTerminalV2Extra();
import { nextTick, ref, watch } from "vue";
import AppIcon from "../../../icons/AppIcon.vue";
import { useI18n } from "../../../composables/useI18n.js";
import { normalizeTerminalNameV2, type TerminalTabRowV2 } from "../protocol-v2.js";
const props = defineProps<{
  rows: TerminalTabRowV2[];
  activeTermId: string | null;
  busy: boolean;
  canCreate: boolean;
}>();
const emit = defineEmits<{
  select: [termId: string];
  close: [row: TerminalTabRowV2];
  rename: [termId: string, name: string];
  create: [];
}>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const renamingId = ref<string | null>(null);
const draft = ref("");
const nameError = ref(false);
watch(
  () => props.rows,
  (rows) => {
    if (renamingId.value && !rows.some((row) => row.termId === renamingId.value)) cancelRename();
  },
);
function tabButton(termId: string): HTMLButtonElement | undefined {
  return [...(root.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find(
    (button) => button.dataset["terminalTabId"] === termId,
  );
}
async function beginRename(row: TerminalTabRowV2): Promise<void> {
  renamingId.value = row.termId;
  draft.value = row.name;
  nameError.value = false;
  await nextTick();
  const input = root.value?.querySelector<HTMLInputElement>(".terminal-v2-rename-input");
  input?.focus();
  input?.select();
}
function cancelRename(): void {
  const id = renamingId.value;
  renamingId.value = null;
  nameError.value = false;
  if (id) void nextTick(() => tabButton(id)?.focus());
}
function commitRename(): void {
  const id = renamingId.value;
  if (!id) return;
  const name = normalizeTerminalNameV2(draft.value);
  if (!name) {
    nameError.value = true;
    return;
  }
  renamingId.value = null;
  nameError.value = false;
  emit("rename", id, name);
  void nextTick(() => tabButton(id)?.focus());
}
async function navigate(event: KeyboardEvent, row: TerminalTabRowV2): Promise<void> {
  if (event.key === "F2") {
    event.preventDefault();
    await beginRename(row);
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const index = props.rows.findIndex((item) => item.termId === row.termId);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? props.rows.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + props.rows.length) % props.rows.length;
  const next = props.rows[nextIndex];
  if (!next) return;
  emit("select", next.termId);
  await nextTick();
  tabButton(next.termId)?.focus();
}
defineExpose({ beginRename });
</script>
<template>
  <div class="terminal-v2-tabs-row">
    <div ref="root" class="terminal-v2-tabs" role="tablist" :aria-label="t('terminalV2.title')">
      <div
        v-for="row in rows"
        :key="row.termId"
        class="terminal-v2-tab-wrap"
        :class="{ 'is-active': row.termId === activeTermId }"
        role="presentation"
      >
        <input
          v-if="renamingId === row.termId"
          v-model="draft"
          class="terminal-v2-rename-input"
          type="text"
          maxlength="24"
          :aria-label="t('terminalV2.renameLabel', { name: row.name })"
          :aria-invalid="nameError"
          @keydown.enter.prevent.stop="commitRename"
          @keydown.esc.prevent.stop="cancelRename"
          @blur="commitRename"
        />
        <template v-else>
          <button
            class="terminal-v2-tab-select"
            type="button"
            role="tab"
            :id="`terminal-v2-tab-${row.termId}`"
            :data-terminal-tab-id="row.termId"
            :aria-selected="row.termId === activeTermId"
            :aria-controls="'terminal-v2-workspace'"
            :aria-label="t('terminalV2.switchTab', { name: row.name })"
            :tabindex="row.termId === activeTermId ? 0 : -1"
            @click="emit('select', row.termId)"
            @dblclick="beginRename(row)"
            @keydown="navigate($event, row)"
          >
            <AppIcon name="terminal" class="icon" />
            <span class="terminal-v2-tab-name">{{ row.name }}</span>
            <span class="terminal-v2-tab-state">{{ row.state }}</span>
          </button>
          <button
            class="terminal-v2-tab-close"
            type="button"
            :disabled="busy"
            :aria-label="t('terminalV2.closeTab', { name: row.name })"
            :title="t('terminalV2.closeTab', { name: row.name })"
            @click="emit('close', row)"
          >
            <span aria-hidden="true">×</span>
          </button>
        </template>
      </div>
    </div>
    <button
      class="btn btn-ghost terminal-v2-new-tab"
      type="button"
      :disabled="busy || !canCreate"
      :aria-label="t('terminalV2.newTab')"
      :title="t('terminalV2.newTab')"
      @click="emit('create')"
    >
      <span aria-hidden="true">+</span>
    </button>
    <span v-if="nameError" class="sr-only" role="alert">{{ t("terminalV2.invalidName") }}</span>
  </div>
</template>
