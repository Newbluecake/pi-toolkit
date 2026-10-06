<!--
  SpawnModelField — the DirPicker's 「本次模型」 field (web-hub-spawn default-model plan F2,
  decisions D6/D7). A dumb, presentation-only input + datalist: every behavior decision
  (cap gating, the `prefs.defaultModel ?? ""` initial value, always sending `model`
  explicitly on submit, failure restore) lives in `DirPicker.vue`; this component only owns

  - the label (`spawn.pickerModelLabel`) and the free-typed input with a `<datalist>` of the
    known-model union (D7 — computed by the parent via `@logic/models.js`'s
    `knownModelRefs`/`readModelCache`, exactly like SettingsView's default-model card);
  - the placeholder: 「默认：<hub 默认>」 (`spawn.pickerModelDefault`) when the hub-wide
    preference is set, otherwise the settings card's 「留空表示 pi 默认」 text (reused —
    F2 adds no i18n keys);
  - the live invalid state: `""` is the explicit pi-default tri-state and is never invalid;
    anything else is checked with the hub's OWN gate (`isSpawnModelRef`, i.e. the frozen
    `parseSpawnModelRef` from `@protocol/spawn.ts`) so the UI can never 400 itself on a ref
    the hub would accept. The parent independently disables submit on the same predicate.

  The tri-state recap (D2): `""` submitted ⇒ explicit pi default; `provider/id` ⇒ that model;
  the field is only ever rendered when the hub advertises `spawn.model.v1` (the parent
  gates), so submitting `""` never confuses a pre-feature hub.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { isSpawnModelRef } from "../../logic/models.js";

/** D7's datalist entry — the `{provider, id, name?}` slim shape `knownModelRefs` returns. */
interface SpawnModelOption {
  readonly provider: string;
  readonly id: string;
  readonly name?: string | undefined;
}

const props = defineProps<{
  /** v-model: the raw input value; `""` = explicit pi default (the submit tri-state). */
  readonly modelValue: string;
  /** The hub-wide default (`prefs.defaultModel`) — drives the placeholder; `null` ⇒ pi default. */
  readonly defaultModel: string | null;
  /** D7 datalist options (online-agent union, cache fallback — computed by the parent). */
  readonly options: readonly SpawnModelOption[];
  /** Mirrors the picker's busy phase — the input locks while a flow is in flight. */
  readonly disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { t } = useI18n();

const trimmed = computed(() => props.modelValue.trim());
/** Live local validation (the hub's own `parseSpawnModelRef` via `@logic/models.js`);
 * `""` is the pi-default tri-state, never invalid. */
const invalid = computed(() => trimmed.value !== "" && !isSpawnModelRef(trimmed.value));
const placeholder = computed(() =>
  props.defaultModel !== null && props.defaultModel !== ""
    ? t("spawn.pickerModelDefault", { model: props.defaultModel })
    : t("settings.defaultModelPlaceholder"),
);

function onInput(ev: Event): void {
  const target = ev.target;
  if (target instanceof HTMLInputElement) emit("update:modelValue", target.value);
}
</script>

<template>
  <div class="spawn-field">
    <label class="spawn-field-label" for="spawn-model">{{ t("spawn.pickerModelLabel") }}</label>
    <input
      id="spawn-model"
      class="input spawn-model-input"
      type="text"
      name="spawn-model"
      list="spawn-model-options"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled === true"
      :aria-invalid="invalid === true || undefined"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      translate="no"
      @input="onInput"
    />
    <datalist id="spawn-model-options">
      <option v-for="m in options" :key="`${m.provider}/${m.id}`" :value="`${m.provider}/${m.id}`">
        {{ m.name ?? `${m.provider}/${m.id}` }}
      </option>
    </datalist>
    <p v-if="invalid" class="spawn-picker-note spawn-model-warn" role="alert">
      {{ t("settings.defaultModelInvalid") }}
    </p>
  </div>
</template>
