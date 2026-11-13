<script setup lang="ts">
import { registerTerminalExtra } from "../../i18n/terminal-extra.js";
registerTerminalExtra();
import type { TerminalRow } from "./controller.js";
import { useI18n } from "../../composables/useI18n.js";
const { t } = useI18n();
defineProps<{ rows: readonly TerminalRow[]; busy: boolean }>();
const emit = defineEmits<{ attach: [row: TerminalRow]; terminate: [row: TerminalRow]; create: [] }>();
</script>
<template>
  <section class="terminal-list" :aria-label="t('terminal.list')" :aria-busy="busy">
    <p v-if="!rows.length">{{ t("terminal.empty") }}</p>
    <p
      v-if="
        rows.some(
          (row) =>
            row.sessionOrdinal === undefined ||
            row.writerPresent === undefined ||
            row.createdAt === undefined ||
            !row.ownerLabel,
        )
      "
    >
      {{ t("terminal.metadataHint") }}
    </p>
    <ul v-if="rows.length">
      <li v-for="row in rows" :key="row.termId">
        <strong>{{
          row.sessionOrdinal !== undefined ? `#${row.sessionOrdinal}` : t("terminal.metadataUnavailable")
        }}</strong>
        <code>{{ row.state }}</code>
        <span v-if="row.ownerLabel">{{ row.ownerLabel }}</span>
        <time v-if="row.createdAt !== undefined">{{ new Date(row.createdAt!).toLocaleString() }}</time>
        <span v-if="row.writerPresent !== undefined">{{ row.writerPresent ? "attached" : "background" }}</span>
        <span v-if="row.writerPresent === undefined">{{ t("terminal.metadataUnavailable") }}</span>
        <small
          >idle {{ new Date(row.deadlines.inputIdleAt).toLocaleTimeString() }} · hard
          {{ new Date(row.deadlines.lifetimeAt).toLocaleTimeString() }}</small
        >
        <small v-if="row.baseOffset > 0">[0, {{ row.baseOffset }}) · output dropped</small>
        <button class="btn" :disabled="busy || row.state !== 'live'" @click="emit('attach', row)">
          {{ t("terminal.attach") }}
        </button>
        <button
          class="btn btn-ghost"
          :disabled="busy || row.state === 'exited' || row.state === 'closing'"
          @click="emit('terminate', row)"
        >
          {{ t("terminal.terminate") }}
        </button>
      </li>
    </ul>
    <button class="btn" data-terminal-create :disabled="busy" @click="emit('create')">
      {{ t("terminal.create") }}
    </button>
  </section>
</template>
