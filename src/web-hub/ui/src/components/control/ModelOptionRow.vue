<!--
  Presentational listbox option row shared by every `.model-list` picker (2026-10 extraction,
  born with the settings default-model picker: `control/ModelSwitcher.vue` used to inline this
  markup twice — scoped tab and grouped all-tab — and the new `shell/SettingsModelPicker.vue`
  needs the same row; one component renders it everywhere now). Renders EXACTLY the row
  ModelSwitcher inlined: check icon (visible on the selected row), mono `provider`-scoped id,
  optional display name, and the ctx/reasoning badges (`@logic/models.js`'s `ctxBadge`).
  Stateless by design — selection / keyboard-active highlight / disabled and the pick action
  stay with the parent, so ModelSwitcher's behaviour and DOM are byte-identical in effect
  (`aria-disabled` always renders, `false` when idle, like the switcher's own template did).
-->
<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";
import { ctxBadge } from "@logic/models.js";

/** Local mirror of `@logic/models.js`'s `ModelOption` typedef (the .js module stays the
 * behavioral source of truth — same mirror discipline as ModelSwitcher's interfaces). */
interface ModelOptionItem {
  provider: string;
  id: string;
  name?: string;
  ctx?: number;
  reasoning?: true;
  scoped?: true;
}

defineProps<{
  /** DOM id for the parent's `aria-activedescendant` (the row's index in the open list). */
  optionId?: string | undefined;
  item: ModelOptionItem;
  selected: boolean;
  active?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ pick: [] }>();
</script>

<template>
  <li
    :id="optionId"
    class="model-row"
    :class="{ active: active === true }"
    role="option"
    :aria-selected="selected"
    :aria-disabled="disabled === true"
    @click="emit('pick')"
  >
    <AppIcon name="check" class="icon-sm row-check" />
    <span class="row-id" translate="no">{{ item.id }}</span>
    <span v-if="item.name" class="row-name">{{ item.name }}</span>
    <span class="row-badges">
      <span v-if="ctxBadge(item.ctx)" class="model-badge">{{ ctxBadge(item.ctx) }}</span>
      <span v-if="item.reasoning === true" class="model-badge model-badge-reasoning">R</span>
    </span>
  </li>
</template>
