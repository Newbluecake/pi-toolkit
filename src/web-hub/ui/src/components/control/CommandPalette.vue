<!--
  Slash-command completion list (control-plan.md v2.1 §4.6/§7.7 — C5). Data comes straight from
  the agent's `commands` slot: every row shows its policy badge (allow/confirm/deny — `policyBusy`
  overrides `policy` while the agent is busy, e.g. /compact) and, v2.1, an output badge
  (`captured` ⇒ "output here", `terminal`/absent ⇒ "output in terminal", §4.9 第 10 条). Deny
  rows are greyed with their reason and are not pickable (the agent would answer
  E_COMMAND_DENIED anyway — §4.6's "绝不回落为文本" starts here in the UI).
-->
<script setup lang="ts">
import { computed } from "vue";
import { commandPolicyFor } from "@logic/control.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

interface CommandItem {
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly description?: unknown;
  readonly output?: unknown;
}

const props = defineProps<{
  readonly commands: readonly unknown[];
  readonly query: string;
  readonly busy?: boolean;
}>();
const emit = defineEmits<{ pick: [name: string] }>();
const { t } = useI18n();

interface Row {
  readonly name: string;
  readonly description: string;
  readonly policy: "allow" | "confirm" | "deny";
  readonly output: "captured" | "terminal" | null;
}

const rows = computed<readonly Row[]>(() => {
  const q = props.query.toLowerCase();
  const out: Row[] = [];
  for (const raw of props.commands) {
    const c = raw as CommandItem;
    if (typeof c.name !== "string" || c.name === "") continue;
    if (q !== "" && !c.name.toLowerCase().startsWith(q)) continue;
    out.push({
      name: c.name,
      description: typeof c.description === "string" ? c.description : "",
      policy: commandPolicyFor([...props.commands], c.name, props.busy === true),
      output: c.output === "captured" ? "captured" : c.output === "terminal" ? "terminal" : null,
    });
  }
  return out.slice(0, 50); // commands slot is ≤400 entries; the palette never scrolls forever
});

const policyLabel = (p: Row["policy"]): string =>
  p === "allow" ? t("control.policyAllow") : p === "confirm" ? t("control.policyConfirm") : t("control.policyDeny");
</script>

<template>
  <div class="command-palette" role="listbox" :aria-label="t('control.paletteAria')">
    <button
      v-for="row in rows"
      :key="row.name"
      type="button"
      role="option"
      class="command-item"
      :class="{ denied: row.policy === 'deny' }"
      :aria-selected="false"
      :aria-disabled="row.policy === 'deny' ? true : undefined"
      @click="row.policy !== 'deny' && emit('pick', row.name)"
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
  </div>
</template>
