<!--
  `/name␠` argument palette (web-hub-slash-args plan §6.2 — P3). The ARG half of the command
  combobox: while `argZone` is open the Composer swaps the name palette for this panel. Reuses
  the `.command-palette`/`.command-item` CSS shape (same position, same 240px max-height) but
  NOT `CommandPalette.vue`'s data layer — rows come from the dynamic completion channel, not
  `matchCommandRows`.

  Content: a STATIC header line (`/name` + `args.usage`, falling back to the row description —
  zero requests, always shown while the panel is) above the dynamic rows. Each row: `label`
  (bold) + `description` (weak) + a confirm chip when `policy:"confirm"` (the same chip as the
  command palette; deny items never reach the wire); `title` carries the raw `value` (whole-
  prefix replacement semantics, §2 table). Usage text renders with CSS ellipsis + `title` full
  text (r1 #3).

  States: loading keeps the previous rows and marks the root `aria-busy`, and — only when
  there are NO stale rows to keep visible — shows a "…" hint after a 250ms delay (internal
  timer, avoids a flash on fast responses); empty shows the header + a weak 「无可用补全」
  line; error/429/timeout degrade SILENTLY to the header line only (the `error` prop
  suppresses the empty hint — no error text ever enters the panel). The panel itself is
  mounted/unmounted by the Composer (`argVisible`: active ∧ not dismissed ∧ something to
  show).

  Keyboard model: identical to the name palette — focus never enters the list (rows are
  pointer-only buttons), the composer's textarea drives the highlight via
  aria-activedescendant. Option ids are `<listboxId>-opt-<index>`, mirrored by the Composer.
  No `v-html` anywhere: every cell is interpolation. Mobile (`pointer: coarse`): no Tab — a
  row tap applies (`@mousedown.prevent` keeps the textarea focused through the press).
-->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { ARG_LOADING_HINT_DELAY_MS } from "@logic/cmdArgs.js";
import { useI18n } from "../../composables/useI18n.js";

interface ArgItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly policy?: "confirm";
}

const props = withDefaults(
  defineProps<{
    /** Command name (header `/<name>`); the composer already resolved the zone's row. */
    readonly name: string;
    /** Static header text: `row.args.usage`, falling back to `row.description`. */
    readonly usage?: string | undefined;
    /** Dynamic completion rows (already client-trimmed by `parseCompleteResponse`). */
    readonly items: readonly ArgItem[];
    /** Highlighted row index (combobox aria-activedescendant model — the composer owns it). */
    readonly active?: number;
    /** A query is in flight: keep old rows, mark the root busy, delay the "…" hint. */
    readonly loading?: boolean;
    /** Last query failed / rate-paused with no cache: header-only silent degrade. */
    readonly error?: boolean;
    /** id of the listbox root; option ids are `<listboxId>-opt-<index>` (mirrored by Composer). */
    readonly listboxId?: string;
  }>(),
  { active: 0 },
);
const emit = defineEmits<{ pick: [item: ArgItem]; hover: [index: number] }>();
const { t } = useI18n();

const rowId = (i: number): string | undefined =>
  props.listboxId === undefined ? undefined : `${props.listboxId}-opt-${i}`;

/** The delayed "…" hint: shown only while loading AND there are no stale rows to keep visible
 * (fast responses never flash it; §6.2 / CMD_ARGS.loadingHintDelayMs). */
const loadingHint = ref(false);
let hintTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [props.loading, props.items.length] as const,
  ([loading]) => {
    if (hintTimer !== undefined) {
      clearTimeout(hintTimer);
      hintTimer = undefined;
    }
    loadingHint.value = false;
    if (loading) hintTimer = setTimeout(() => (loadingHint.value = true), ARG_LOADING_HINT_DELAY_MS);
  },
  { immediate: true },
);
onUnmounted(() => {
  if (hintTimer !== undefined) clearTimeout(hintTimer);
});

const headerText = computed(() => (typeof props.usage === "string" && props.usage !== "" ? props.usage : undefined));
</script>

<template>
  <div
    :id="listboxId"
    class="command-palette arg-palette"
    role="listbox"
    :aria-label="t('control.argAria')"
    :aria-busy="loading ? 'true' : undefined"
  >
    <div v-if="headerText !== undefined || items.length > 0" class="arg-head" :aria-label="t('control.argUsage')">
      <span class="command-name" translate="no">/{{ name }}</span>
      <span v-if="headerText !== undefined" class="command-desc arg-usage" :title="headerText">{{ headerText }}</span>
    </div>
    <template v-if="items.length > 0">
      <button
        v-for="(item, i) in items"
        :key="item.value"
        :id="rowId(i)"
        type="button"
        role="option"
        class="command-item arg-item"
        :class="{ active: i === active }"
        :aria-selected="i === active"
        :title="item.value"
        @click="emit('pick', item)"
        @mousedown.prevent
        @mousemove="emit('hover', i)"
      >
        <span class="command-name" translate="no">{{ item.label }}</span>
        <span v-if="item.description" class="command-desc">{{ item.description }}</span>
        <span v-if="item.policy === 'confirm'" class="command-badges">
          <span class="chip policy-chip" data-policy="confirm">{{ t("control.policyConfirm") }}</span>
        </span>
      </button>
      <p class="command-hint">{{ t("control.argHint") }}</p>
    </template>
    <p v-else-if="loadingHint" class="command-empty">{{ t("control.argLoading") }}</p>
    <p v-else-if="!loading && !error" class="command-empty">{{ t("control.argEmpty") }}</p>
  </div>
</template>
