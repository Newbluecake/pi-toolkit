<!--
  Slash-command completion list (control-plan.md v2.1 §4.6/§7.7 — C5). Data comes straight from
  the agent's `commands` slot: every row shows its policy badge (allow/confirm/deny — `policyBusy`
  overrides `policy` while the agent is busy, e.g. /compact) and, v2.1, an output badge
  (`captured` ⇒ "output here", `terminal`/absent ⇒ "output in terminal", §4.9 第 10 条). Deny
  rows are greyed with their reason and are not pickable (the agent would answer
  E_COMMAND_DENIED anyway — §4.6's "绝不回落为文本" starts here in the UI).

  Keyboard model (2026-10 user request 「/ 开头激活选项后，支持 Tab 选择并继续输入过滤」): this is
  the LISTBOX half of a combobox — focus NEVER enters the list (buttons are pointer-only), the
  composer's textarea owns the highlight via aria-activedescendant and drives it with
  ArrowUp/ArrowDown/Shift+Tab (wrap), Tab completes the highlighted row, Esc closes. `active`
  is the highlighted index (default 0 = best match); `hover` reports pointer hovers so the
  composer's highlight (and aria) follows the mouse like the @mention panel's does. Rows come
  from the SHARED pure matcher `matchCommandRows` (`@logic/control.js`) so the composer's
  keyboard model and this render can never drift — same query, same order, same 50-row cap.
  Option ids are `<listboxId>-opt-<index>`; the composer mirrors the format for
  aria-activedescendant.
-->
<script setup lang="ts">
import { computed } from "vue";
import { matchCommandRows } from "@logic/control.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = withDefaults(
  defineProps<{
    readonly commands: readonly unknown[];
    readonly query: string;
    readonly busy?: boolean;
    /** Highlighted row index (combobox aria-activedescendant model — the composer owns it). */
    readonly active?: number;
    /** id of the listbox root; option ids are `<listboxId>-opt-<index>` (mirrored by Composer). */
    readonly listboxId?: string;
  }>(),
  { active: 0 },
);
const emit = defineEmits<{ pick: [name: string]; hover: [index: number] }>();
const { t } = useI18n();

const rows = computed(() => matchCommandRows([...props.commands], props.query, props.busy === true));
const rowId = (i: number): string | undefined =>
  props.listboxId === undefined ? undefined : `${props.listboxId}-opt-${i}`;

const policyLabel = (p: "allow" | "confirm" | "deny"): string =>
  p === "allow" ? t("control.policyAllow") : p === "confirm" ? t("control.policyConfirm") : t("control.policyDeny");
</script>

<template>
  <div :id="listboxId" class="command-palette" role="listbox" :aria-label="t('control.paletteAria')">
    <button
      v-for="(row, i) in rows"
      :key="row.name"
      :id="rowId(i)"
      type="button"
      role="option"
      class="command-item"
      :class="{ denied: row.policy === 'deny', active: i === active }"
      :aria-selected="i === active"
      :aria-disabled="row.policy === 'deny' ? true : undefined"
      @click="row.policy !== 'deny' && emit('pick', row.name)"
      @mousemove="emit('hover', i)"
    >
      <span class="command-name" translate="no">/{{ row.name }}</span>
      <span v-if="row.description" class="command-desc">{{ row.description }}</span>
      <span class="command-badges">
        <span v-if="row.output === 'captured'" class="chip chip-muted">{{ t("control.outputHere") }}</span>
        <span v-else-if="row.output === 'terminal'" class="chip chip-muted">{{ t("control.outputTerminal") }}</span>
        <span class="chip policy-chip" :data-policy="row.policy">{{ policyLabel(row.policy) }}</span>
      </span>
      <span v-if="row.policy === 'deny'" class="command-denied-reason">{{ t("control.cmdDeniedTerminal") }}</span>
    </button>
    <p v-if="rows.length === 0" class="command-empty">
      <AppIcon name="ban" class="icon-sm" />{{ t("control.cmdDeniedUnknown") }}
    </p>
    <p v-else class="command-hint">{{ t("control.paletteHint") }}</p>
  </div>
</template>
