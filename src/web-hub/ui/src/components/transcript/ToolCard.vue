<!--
  Tool call card (ui-design.md §5.4, vue-plan.md v2.1 §3.1/§5.2 — P4): a `<details>` summary
  (state icon, name, one-line args summary, truncated badge, chevron) expanding to Input / Live
  output / Output sections. `summarizeArgs`/`safeJson` are the tested `@logic/render/tools.js`
  pure functions, reused unchanged. A running call's `partial` is tail-truncated to 200 lines /
  16 KiB (`tail-lines.ts`, ui-design.md §6.6) with a "Show full output" toggle that switches to
  the full text (still held in full in `state`, per the plan — this only gates what's *rendered*).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { safeJson, summarizeArgs } from "@logic/tools.js";
import type { ToolCardProps } from "../../contracts.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { tailLines } from "./tail-lines.js";

const props = defineProps<ToolCardProps>();
const { t } = useI18n();

const TOOL_STATE_ICON = { pending: "clock", running: "loader", done: "check", error: "x" } as const;
const TOOL_STATE_ATTR = { pending: "pending", running: "running", done: "done", error: "failed" } as const;

const icon = computed(() => TOOL_STATE_ICON[props.view.state]);
const dataSt = computed(() => TOOL_STATE_ATTR[props.view.state]);
const spins = computed(() => props.view.state === "running");
const argsText = computed(() => {
  const args = props.view.args;
  if (args === undefined) return undefined;
  return typeof args === "string" ? args : safeJson(args, true);
});
const endLabel = computed(() => {
  const v = props.view;
  if (v.state === "error") return t("transcript.tool.error");
  if (v.state === "done" && typeof v.result === "string") {
    const n = v.result === "" ? 0 : v.result.split("\n").length;
    return t("transcript.tool.lines", { n });
  }
  return "";
});

const showFullPartial = ref(false);
const partialTail = computed(() => tailLines(props.view.partial ?? ""));
const displayedPartial = computed(() => (showFullPartial.value ? (props.view.partial ?? "") : partialTail.value.text));
const partialIsTruncated = computed(() => !showFullPartial.value && partialTail.value.truncated);

const hasBody = computed(
  () =>
    argsText.value !== undefined ||
    (props.view.partial !== undefined && props.view.partial !== "") ||
    props.view.result !== undefined,
);
</script>

<template>
  <details class="tool" :class="`tool-${view.state}`" :data-st="dataSt" :data-key="view.toolCallId">
    <summary class="tool-head">
      <span v-if="view.state === 'running'" class="tool-progress" aria-hidden="true"></span>
      <span class="run-icon"><AppIcon :name="icon" :class="{ spin: spins }" /></span>
      <span class="tool-name" translate="no">{{ view.toolName }}</span>
      <span class="tool-args" translate="no">{{ summarizeArgs(view.args) }}</span>
      <span v-if="view.truncated" class="badge badge-trunc" :title="t('transcript.truncatedTitle')">{{
        t("transcript.truncated")
      }}</span>
      <span v-if="endLabel" class="tool-end"
        ><span>{{ endLabel }}</span></span
      >
      <AppIcon name="chev-right" class="icon icon-sm chev" />
    </summary>
    <div v-if="hasBody" class="tool-body">
      <div v-if="argsText !== undefined" class="tool-section">
        <div class="tool-label">{{ t("transcript.tool.input") }}</div>
        <pre class="pre" translate="no" tabindex="0">{{ argsText }}</pre>
      </div>
      <div v-if="view.partial !== undefined && view.partial !== ''" class="tool-section">
        <div class="tool-label">
          {{ t("transcript.tool.liveOutput") }}
          <button v-if="partialIsTruncated" class="btn btn-ghost btn-xs" type="button" @click="showFullPartial = true">
            {{ t("transcript.tool.showFull") }}
          </button>
        </div>
        <pre class="pre" translate="no" tabindex="0">{{ displayedPartial }}</pre>
      </div>
      <div v-if="view.result !== undefined" class="tool-section" :class="{ 'is-error': view.state === 'error' }">
        <div class="tool-label">
          {{ view.state === "error" ? t("transcript.tool.result") : t("transcript.tool.output") }}
        </div>
        <pre class="pre" translate="no" tabindex="0">{{ view.result }}</pre>
      </div>
    </div>
  </details>
</template>
