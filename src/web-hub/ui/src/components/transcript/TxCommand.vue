<!--
  Command-history card (web-hub-cmd-history plan v2 §4.7, style baseline
  /tmp/cmd-history-preview.html — user-approved 2026-10-24): one folded start+end record
  (`entries.ts`'s `foldCmdRecords`) rendered as a purple-left-border card in the conversation
  stream. Header: `/name args` + state chip (running spinner → done / failed / 已截止 /
  结果未记录 — updated IN PLACE when the end record folds in) + copy button; `msg-head` chips:
  source (web/tui/飞书/rpc/other) + 「不进上下文」. Body: notify level rows, widget/status
  groups, text/error blocks — every line through `PathText` (TEXT NODES ONLY, never `v-html` —
  source-scan enforced), so absolute paths and local http:// links keep the existing preview /
  proxy affordances (G3, §4.8). >CMD_FOLD_LINES lines ⇒ collapsed with 「展开全部/收起」.
  Notices: terminal-only / sensitive / no-output banners (left-session carries its own output
  line, §4.7). The record never enters the model's context (custom entry, conformance-pinned).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { CommandOutputWire } from "@protocol/messages.js";
import AppIcon from "../../icons/AppIcon.vue";
import CopyButton from "../detail/CopyButton.vue";
import PathText from "../preview/PathText.vue";
import { useI18n } from "../../composables/useI18n.js";
import { formatDateTime } from "../../format.js";
import {
  CMD_FOLD_LINES,
  cmdBodyBlocks,
  cmdInteractiveSteps,
  cmdLineCount,
  cmdPlainText,
  type CmdCardView,
} from "../../logic/cmdRecord.js";

const props = defineProps<{ readonly view: CmdCardView }>();
const i18n = useI18n();
const { t } = i18n;

const timeLabel = computed(() => formatDateTime(props.view.startedAt, i18n.lang === "zh" ? "zh-CN" : "en-US"));

const sourceLabel = computed(() =>
  props.view.source === "feishu" ? t("transcript.cmdSourceFeishu") : props.view.source,
);

/** done / failed / running stay English TOKENS in both locales (the approved preview's chips);
 *  timeout / unrecorded are zh-localized per plan §4.7. */
const stateLabel = computed(() => {
  switch (props.view.state) {
    case "timeout":
      return t("transcript.cmdStateTimeout");
    case "unrecorded":
      return t("transcript.cmdStateUnrecorded");
    default:
      return props.view.state;
  }
});

const blocks = computed(() => cmdBodyBlocks(props.view.output));
const interactiveSteps = computed(() => cmdInteractiveSteps(props.view.output));

/** Interactive line wording: a WEB-claimed command skipped the steps on the web (they need the
 *  terminal); an observed (tui/rpc) command already interacted there (§4.7). */
const interactiveLabel = computed(() => {
  const steps = interactiveSteps.value.join(", ");
  return props.view.source === "web" || props.view.source === "feishu"
    ? t("transcript.cmdNeedsTerminal", { steps })
    : t("transcript.cmdInteractedTerminal", { steps });
});

const noticeLabel = computed(() => {
  switch (props.view.notice) {
    case "terminal-only":
      return t("transcript.cmdNoticeTerminalOnly");
    case "sensitive":
      return t("transcript.cmdNoticeSensitive");
    case "no-output":
      return t("transcript.cmdNoticeNoOutput");
    default:
      return ""; // left-session: its output carries the leave line — no extra banner (§4.7)
  }
});

const truncated = computed(() => props.view.output?.truncated);
const truncatedFooter = computed(() => {
  const tr = truncated.value;
  if (tr === undefined) return "";
  return t("control.cmdOutput.truncated", { entries: tr.droppedEntries, kib: Math.ceil(tr.droppedBytes / 1024) });
});

const hasBody = computed(
  () =>
    blocks.value.length > 0 ||
    interactiveSteps.value.length > 0 ||
    noticeLabel.value !== "" ||
    (typeof props.view.error === "string" && props.view.error !== "") ||
    truncatedFooter.value !== "",
);

const copyText = computed(() => cmdPlainText(props.view));
/** Copy stays available on ended cards (the header line alone is already useful); the
 *  running/unrecorded placeholder states have nothing to copy (preview baseline). */
const copyable = computed(
  () => props.view.state === "done" || props.view.state === "failed" || props.view.state === "timeout",
);

const expanded = ref(false);
const foldable = computed(() => cmdLineCount(props.view) > CMD_FOLD_LINES);
const clamped = computed(() => foldable.value && !expanded.value);

function clippedMark(clipped: boolean): string {
  return clipped ? t("control.cmdOutput.clipped") : "";
}
</script>

<template>
  <article class="msg-cmd tx-item" :data-state="view.state">
    <span class="avatar avatar-cmd"><AppIcon name="terminal" class="icon" /></span>
    <div class="msg-main">
      <div class="msg-head">
        <span class="who">{{ t("transcript.cmdWho") }}</span>
        <span class="cmd-chip cmd-chip-src" translate="no">{{ sourceLabel }}</span>
        <span class="chip chip-noctx">{{ t("transcript.cmdNoContext") }}</span>
        <span class="end">
          <span v-if="timeLabel" translate="no">{{ timeLabel }}</span>
        </span>
      </div>
      <div class="cmd-card">
        <div class="cmd-card-head">
          <code class="cmd-invocation" translate="no"
            >/{{ view.name }}{{ view.args === "" ? "" : ` ${view.args}` }}</code
          >
          <span class="chip cmd-state" :data-state="view.state">
            <AppIcon v-if="view.state === 'running'" name="loader" class="icon-sm spin" />{{ stateLabel }}</span
          >
          <span class="cmd-sp"></span>
          <CopyButton
            v-if="copyable"
            :value="copyText"
            :label="t('transcript.cmdCopy')"
            :title="t('transcript.cmdCopy')"
          />
        </div>

        <div class="cmd-card-body" :class="{ 'is-clamped': clamped }">
          <p v-if="view.state === 'running'" class="cmd-muted">{{ t("transcript.cmdRunningBody") }}</p>
          <p v-else-if="view.state === 'unrecorded'" class="cmd-muted">{{ t("transcript.cmdUnrecordedBody") }}</p>
          <template v-else>
            <template v-for="(b, i) in blocks" :key="i">
              <div v-if="b.kind === 'notify'" class="cmd-row">
                <span class="cmd-lv" :data-level="b.level">{{ b.level }}</span>
                <pre class="cmd-pre"><PathText :text="b.text" />{{ clippedMark(b.clipped) }}</pre>
              </div>
              <div v-else-if="b.kind === 'group'" class="cmd-row cmd-row-group">
                <span v-if="b.key !== ''" class="cmd-key" translate="no">{{ b.key }}</span>
                <pre class="cmd-pre"><PathText :text="b.text" />{{ clippedMark(b.clipped) }}</pre>
              </div>
              <pre
                v-else-if="b.kind === 'error'"
                class="cmd-pre cmd-pre-err"
              ><PathText :text="b.text" />{{ clippedMark(b.clipped) }}</pre>
              <pre v-else class="cmd-pre"><PathText :text="b.text" />{{ clippedMark(b.clipped) }}</pre>
            </template>
            <p v-if="interactiveSteps.length > 0" class="cmd-note-line">{{ interactiveLabel }}</p>
            <div v-if="typeof view.error === 'string' && view.error !== ''" class="cmd-row">
              <span class="cmd-lv" data-level="error">error</span>
              <pre class="cmd-pre"><PathText :text="view.error" /></pre>
            </div>
            <p v-if="noticeLabel !== ''" class="cmd-note-line">{{ noticeLabel }}</p>
            <p v-if="truncatedFooter !== ''" class="cmd-note-line cmd-truncated">{{ truncatedFooter }}</p>
            <p v-if="!hasBody" class="cmd-muted">{{ t("transcript.cmdNoticeNoOutput") }}</p>
          </template>
        </div>

        <button v-if="foldable" class="cmd-fold" type="button" @click="expanded = !expanded">
          {{ expanded ? t("transcript.collapse") : t("transcript.showAll") }}
        </button>
      </div>
    </div>
  </article>
</template>
