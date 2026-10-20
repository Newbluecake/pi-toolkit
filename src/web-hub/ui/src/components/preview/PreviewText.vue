<!--
  Text phase of the preview overlay (web-hub-preview plan v3 §4.6, package PV5; dir-plan
  v3.1 §4.1/§4.3, PM package): the body in a monospace `<pre>` (whitespace preserved,
  soft-wrapped by CSS), a truncated badge + note when the server clipped the body at
  `PREVIEW_TEXT_MAX_BYTES` (`X-PWH-Preview-Truncated`), and the copy value — exactly the
  DISPLAYED part (§4.6: "复制按钮复制的是已显示的部分", never the path) — published to the
  header via `update:copyValue` (2026-10-20: the copy button moved from this toolbar to
  PreviewHost's header, next to download; this component stays the sole source of the value).

  Markdown rendering (B1–B7, PM package): a `.md`/`.markdown` path defaults to RENDERED —
  `@logic/markdown.js`'s whitelist parser → the transcript's own `MdBlock` renderer (the
  `md` class rides along so the shared `transcript.css` typography applies; no `v-html`
  anywhere, HTML/`javascript:` links/`![img]` stay literal text). A segmented rendered/
  source toggle (`aria-pressed`) switches to today's exact `<pre><HighlightedCode>` view;
  the Host remounts this component per `view.path` (`:key`), so every freshly opened file
  resets to rendered while a same-path retry keeps the current choice (B4, not persisted).
  A truncated md drops its incomplete final line (`prepareMarkdownPreview`) in BOTH modes
  and adds the "结尾可能不完整" note in rendered mode (B5). The AST node budget
  (`PREVIEW_MD_NODE_MAX`) forces source mode with a note + disabled rendered button (B7) —
  `HighlightedCode`'s own large-text degradation then covers the source view. Non-md files
  render the exact pre-change DOM (no toggle, no extra nodes).

  Chunked streaming (chunked-plan §4.4–§4.6, P2b): with the `stream` prop (built by
  `usePreview`, the sole writer) the body is a list of append-only SEGMENTS — source view:
  one `.preview-seg` div per segment (§4.3.4 cut rule ⇒ line-identical to a single `<pre>`),
  rendered md view: one `.preview-seg` per top-level-blank-delimited block (`MdBlock`, or a
  source fallback for over-budget blocks). Old segments are never re-patched (markRaw +
  stable ids); a 1px sentinel at the end of the scroll container feeds an
  IntersectionObserver (800px look-ahead) that emits `load-more`; progress/error/limit state
  lives in the actions row OUTSIDE the scroll area so nothing above the viewport ever changes
  height (no scroll jump). No syntax highlight in stream mode (it would swap DOM later).
  Never `content-visibility` (#11 Aw Snap) — source-scan pins it.
-->
<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  inject,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { resolveFileLang } from "@logic/highlight.js";
import { createAnsiStripper, stripAnsi } from "@logic/ansi.js";
import { parseMarkdown } from "@logic/markdown.js";
import {
  countMdNodes,
  isHtmlPath,
  isMarkdownPath,
  prepareMarkdownPreview,
  PREVIEW_MD_NODE_MAX,
} from "@logic/preview.js";
import { createMarkdownSegmenter, createSourceSegmenter } from "@logic/previewStream.js";
import MdBlock from "../transcript/MdBlock.vue";
import type { MdNode } from "../transcript/markdown-types.js";
import HighlightedCode from "../shared/HighlightedCode.vue";
import { HUB_CTX } from "../control/controlContext.js";
import { MD_IMAGE_LOADER, PREVIEW_BASE_DIR, PREVIEW_CTX } from "./previewContext.js";
import { createMdImageFetcher, createMdImageLoader } from "../../composables/useMdImageLoader.js";
import { dirOfPreviewPath } from "@logic/mdLinkPath.js";
import type { PreviewTextStream } from "../../types.js";

type SourceSegment = ReturnType<ReturnType<typeof createSourceSegmenter>["push"]>[number];
type MdSegment = ReturnType<ReturnType<typeof createMarkdownSegmenter>["push"]>[number];

const props = defineProps<{
  readonly text: string;
  readonly truncated: boolean;
  /** Host-formatted byte count of the DISPLAYED body (truncated note, non-stream mode). */
  readonly loadedLabel?: string | undefined;
  /** Host-formatted byte count of the whole file (truncated note, non-stream mode). */
  readonly totalLabel?: string | undefined;
  /** chunked-plan §4.2: the continuation stream (absent ⇒ legacy one-shot display). */
  readonly stream?: PreviewTextStream | undefined;
  /**
   * Basename of the previewed file (from `PreviewHost`'s header basename) — drives the
   * syntax-highlight language guess (`@logic/highlight.js`'s `resolveFileLang`). Absent /
   * unknown extension ⇒ plain text, DOM identical to pre-highlight.
   */
  readonly filename?: string | undefined;
  /** Full request path (PM package) — the markdown extension check runs on it (B1). */
  readonly path?: string | undefined;
}>();
const emit = defineEmits<{
  (e: "load-more"): void;
  (e: "reopen"): void;
  (e: "retry-stream"): void;
  /** 2026-10-20: the copy button lives in PreviewHost's header now — this is the channel the
   *  header's CopyButton reads. Emitted on mount and on every change; `null` on unmount. */
  (e: "update:copyValue", value: string | null): void;
}>();
const { t } = useI18n();
const highlightLang = computed(() => resolveFileLang(props.filename ?? ""));

// --- sandboxed HTML render (web-hub-html-preview plan v2 §5, package P2) ------------------
// Lazy by design (§5 budget: the lazy JS budget is a 128 KiB gz TOTAL) — PreviewHtml and its
// mint/iframe machinery never enter the first-screen bundle. Absent cap / absent transport /
// non-`.html` path ⇒ `htmlOn` false ⇒ zero DOM change (plain source view, byte-identical).
const PreviewHtml = defineAsyncComponent(() => import("./PreviewHtml.vue"));
const previewCtx = inject(PREVIEW_CTX, null);
// Relative markdown links in the rendered view resolve against the previewed file's directory.
provide(
  PREVIEW_BASE_DIR,
  computed(() => dirOfPreviewPath(props.path ?? "")),
);
const hub = inject(HUB_CTX, null);
// md-preview-html plan: the per-document inline-image loader. One per PreviewText mount (the
// Host remounts per path ⇒ file switch = fresh budget), shared by the stream segments; every
// bound (24 images / 2 in flight / 32 MiB decoded) is document-wide. The fetcher rides the
// SAME preview transport + maxPixels budget as an image preview; dispose() (unmount — incl.
// the rendered→source mode switch, which unmounts the MdBlock subtree) aborts in-flight.
const mdCoarse = (): boolean => {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
};
const mdImageLoader = createMdImageLoader({
  fetchImage: createMdImageFetcher({
    transport: () => hub?.preview,
    scope: () => previewCtx?.handle.scope.value ?? null,
    coarse: mdCoarse,
  }),
});
provide(MD_IMAGE_LOADER, mdImageLoader);
onBeforeUnmount(() => mdImageLoader.dispose());
const isHtml = computed(() => isHtmlPath(props.path ?? props.filename ?? ""));
const scope = computed(() => previewCtx?.handle.scope.value ?? null);
const htmlOn = computed(() => isHtml.value && scope.value?.html === true && hub?.preview?.htmlCap !== undefined);
/** The mint session pair — the scope is stable for an open dialog's lifetime (a scope change
 *  closes it), exactly like PreviewHost's download derivation. */
const htmlAgent = computed(() =>
  htmlOn.value && scope.value !== null ? { agentKey: scope.value.agentKey, sessionId: scope.value.sessionId } : null,
);
/** A mint failure carries a one-line reason in the SOURCE view (403 dir-too-broad/upload ⇒ the
 *  prose note; anything else ⇒ the generic line); 429/5xx/network/deadline add a retry that
 *  flips back to rendered (remounting PreviewHtml ⇒ a fresh mint). */
const htmlDenied = ref<{ status: number; error: string; reason?: string } | null>(null);
const htmlRendered = computed(() => htmlAgent.value !== null && mode.value === "rendered");
const htmlNoteText = computed(() => {
  const err = htmlDenied.value;
  if (err === null) return "";
  if (err.reason === "dir-too-broad") return t("preview.htmlDenied.dirTooBroad");
  if (err.reason === "upload") return t("preview.htmlDenied.upload");
  return t("preview.htmlMintFailed", { code: err.error });
});
const htmlRetryable = computed(() => {
  const err = htmlDenied.value;
  if (err === null) return false;
  return err.status === 429 || err.status >= 500 || err.error === "E_NETWORK" || err.error === "E_DEADLINE";
});
function onHtmlMintError(err: { status: number; error: string; reason?: string }): void {
  htmlDenied.value = err;
  mode.value = "source"; // §5: mint failure ⇒ fall back to source with a one-line reason
}
function retryHtml(): void {
  htmlDenied.value = null;
  mode.value = "rendered"; // remounts PreviewHtml ⇒ re-mint
}
/** The shared toggle handler: switching (back) to rendered clears a stale html mint-failure
 *  note — the re-mount is itself the retry. */
function onToggle(m: "rendered" | "source"): void {
  mode.value = m;
  if (m === "rendered" && htmlOn.value) htmlDenied.value = null;
}
/** B3 aria-pressed: md follows the complexity-capped effectiveMode; html follows `mode`
 *  directly (no AST budget — the browser renders it, not the whitelist parser). */
const pressedRendered = computed(() => (isMd.value ? effectiveMode.value === "rendered" : mode.value === "rendered"));

// --- markdown mode (B1–B7) -------------------------------------------------------------
const isMd = computed(() => isMarkdownPath(props.path ?? props.filename ?? ""));
/** B5 + L1: shown source = ANSI-stripped raw body (terminal logs render clean — the display,
 * the copy button and the markdown parse all see this; download keeps the raw bytes via
 * PreviewHost's own refetch), minus a truncated md's incomplete final line. */
const shownSource = computed(() => {
  const stripped = stripAnsi(props.text);
  return isMd.value ? prepareMarkdownPreview(stripped, props.truncated) : stripped;
});
/** B4: per-open mode (the Host's `:key="view.path"` resets it on every new file). */
const mode = ref<"rendered" | "source">("rendered");
const mdNodes = computed<readonly MdNode[] | null>(() =>
  isMd.value && props.stream === undefined
    ? (parseMarkdown(shownSource.value, { preview: true }) as readonly MdNode[])
    : null,
);
/** B7: over the AST budget ⇒ forced source mode (rendered button disabled + note). */
const mdTooComplexRaw = computed(() => mdNodes.value !== null && countMdNodes(mdNodes.value) > PREVIEW_MD_NODE_MAX);
/** B7 + B1: rendered only for an md file in rendered mode under the node budget; everything
 * else (non-md included — DOM identical to pre-change) renders the source view. */
const effectiveMode = computed<"rendered" | "source">(() =>
  isMd.value && mode.value === "rendered" && !mdTooComplex.value ? "rendered" : "source",
);

// --- chunked stream (§4.3–§4.6) ---------------------------------------------------------
// B7 (whole-text node budget) is a non-stream rule: a stream degrades per segment instead.
const mdTooComplex = computed(() => props.stream === undefined && mdTooComplexRaw.value);
const isStream = computed(() => props.stream !== undefined);
const srcSegs = shallowRef<readonly SourceSegment[]>([]);
const mdSegs = shallowRef<readonly MdSegment[]>([]);
let srcSegmenter: ReturnType<typeof createSourceSegmenter> | null = null;
let mdSegmenter: ReturnType<typeof createMarkdownSegmenter> | null = null;
// L1: each feed strips ANSI before its segmenter — a stripper HOLDS an incomplete trailing
// sequence as a carry, so one split across chunk boundaries never leaves `[36m` residue in
// the next segment (display AND copy therefore see exactly `stripAnsi(whole text)`).
let srcStripper: ReturnType<typeof createAnsiStripper> | null = null;
let mdStripper: ReturnType<typeof createAnsiStripper> | null = null;
let srcCursor = 0;
let mdCursor = 0;
let srcFlushed = false;
let mdFlushed = false;

/** `done` ⇒ exact EOF flush; `cap`/`changed` ⇒ stop flush; everything else keeps pending. */
function terminalFlush(): "eof" | "stop" | null {
  const st = props.stream?.state;
  return st === "done" ? "eof" : st === "cap" || st === "changed" ? "stop" : null;
}

/** The source segmenter ALWAYS follows the stream (cheap string ops; it also backs the copy
 * value in rendered mode). The stripper's carry at a terminal flush is dropped (an
 * unterminated trailing sequence never displays). */
function syncSource(): void {
  const s = props.stream;
  if (s === undefined) return;
  srcSegmenter ??= createSourceSegmenter();
  srcStripper ??= createAnsiStripper();
  const add: SourceSegment[] = [];
  const chunks = s.chunks;
  while (srcCursor < chunks.length) add.push(...srcSegmenter.push(srcStripper.push(chunks[srcCursor++] ?? "")));
  const tf = terminalFlush();
  if (tf !== null && !srcFlushed && srcCursor >= chunks.length) {
    srcFlushed = true;
    srcStripper.flush();
    add.push(...srcSegmenter.flush(tf));
  }
  if (add.length > 0) srcSegs.value = [...srcSegs.value, ...add.map((x) => markRaw(x))];
}

/** The markdown segmenter only catches up while the rendered view is showing (lazy). */
function syncMd(): void {
  const s = props.stream;
  if (s === undefined || !isMd.value || effectiveMode.value !== "rendered") return;
  mdSegmenter ??= createMarkdownSegmenter({ preview: true });
  mdStripper ??= createAnsiStripper();
  const add: MdSegment[] = [];
  const chunks = s.chunks;
  while (mdCursor < chunks.length) add.push(...mdSegmenter.push(mdStripper.push(chunks[mdCursor++] ?? "")));
  const tf = terminalFlush();
  if (tf !== null && !mdFlushed && mdCursor >= chunks.length) {
    mdFlushed = true;
    mdStripper.flush();
    add.push(...mdSegmenter.flush(tf));
  }
  if (add.length > 0) mdSegs.value = [...mdSegs.value, ...add.map((x) => markRaw(x))];
}

function syncStream(): void {
  syncSource();
  syncMd();
}
syncStream();
watch(() => [props.stream?.chunks.length ?? 0, props.stream?.state, effectiveMode.value] as const, syncStream);

/** Copy = the ANSI-stripped consumed source (`text + sep` is strictly the stripped input,
 * §4.3.4 — the raw bytes stay downloadable through PreviewHost's own refetch). */
const copyValue = computed(() =>
  isStream.value ? srcSegs.value.map((x) => x.text + x.sep).join("") : shownSource.value,
);
// Publish to the header (PreviewHost): immediate so the button appears with the dialog,
// re-emitted as chunks arrive / ANSI carries flush; `null` on unmount clears the header.
watch(copyValue, (v) => emit("update:copyValue", v), { immediate: true });
onBeforeUnmount(() => emit("update:copyValue", null));

/** The actions bar is hidden when it would be EMPTY (2026-10-20: the copy button moved to
 *  the header — a non-md/non-html one-shot file, or a stream in its terminal `done` state,
 *  has nothing left to show here). */
const hasActions = computed(
  () => isMd.value || htmlOn.value || (props.stream !== undefined && props.stream.state !== "done"),
);

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const streamState = computed(() => props.stream?.state);
const terminal = computed(
  () => streamState.value === "done" || streamState.value === "cap" || streamState.value === "changed",
);
const statusText = computed(() => {
  const s = props.stream;
  if (s === undefined) return "";
  const params = { loaded: fmtBytes(s.loaded), total: fmtBytes(s.total) };
  switch (s.state) {
    case "more":
      return t("preview.streamProgress", params);
    case "loading":
      return t("preview.streamLoading");
    case "waiting":
      return t("preview.streamWaiting", {
        n: String(Math.max(1, Math.ceil(((s.retryAt ?? Date.now()) - Date.now()) / 1000))),
      });
    case "cap":
      return t("preview.streamCap", params);
    case "changed":
      return t("preview.streamChanged");
    case "error":
      return t("preview.streamError", { code: s.error ?? "?" });
    default:
      return "";
  }
});
const segNote = (reason: string): string =>
  reason === "total-budget" ? t("preview.streamBudgetSource") : t("preview.streamSegSource");

// --- scroll trigger (§4.5): IntersectionObserver on a 1px sentinel ------------------------
const scrollEl = ref<HTMLElement | null>(null);
const sentinelEl = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
let sentinelVisible = false;

function disconnect(): void {
  if (io !== null) {
    io.disconnect();
    io = null;
  }
  sentinelVisible = false;
}

function observe(): void {
  disconnect();
  if (!isStream.value || terminal.value) return;
  if (typeof IntersectionObserver === "undefined") return;
  const root = scrollEl.value;
  const target = sentinelEl.value;
  if (root === null || target === null) return;
  io = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (last === undefined) return;
      sentinelVisible = last.isIntersecting;
      if (sentinelVisible) emit("load-more");
    },
    { root, rootMargin: "0px 0px 800px 0px", threshold: 0 },
  );
  io.observe(target);
}

onMounted(observe);
onBeforeUnmount(disconnect);
// the scroll container is a different element per view mode — re-observe after the swap
watch(effectiveMode, () => void nextTick(observe));
watch(terminal, (isTerminal) => {
  if (isTerminal) disconnect();
});
// IO only fires on intersection CHANGES: a short segment (or a held md tail) leaves the
// sentinel visible with nothing new to report — re-emit when the stream is idle again.
watch(streamState, (st) => {
  if (st === "more") {
    if (io === null) observe();
    if (sentinelVisible) emit("load-more");
  }
});
</script>

<template>
  <div class="preview-text">
    <p v-if="truncated && !stream" class="preview-truncated" role="note">
      <span class="preview-badge">{{ t("preview.truncatedBadge") }}</span>
      <span>{{
        effectiveMode === "rendered"
          ? t("preview.truncatedRenderNote", { loaded: loadedLabel ?? "", total: totalLabel ?? "" })
          : t("preview.truncatedNote", { loaded: loadedLabel ?? "", total: totalLabel ?? "" })
      }}</span>
    </p>
    <p v-if="mdTooComplex" class="preview-md-note" role="note">{{ t("preview.mdTooComplex") }}</p>
    <!-- web-hub-html-preview §5: a failed html mint keeps the source view usable and explains
         itself in one line (403 dir-too-broad/upload ⇒ the prose variant); retryable errors
         get a retry that flips back to rendered (remount ⇒ re-mint). -->
    <p v-if="htmlOn && htmlDenied !== null" class="preview-md-note" role="note">
      <span>{{ htmlNoteText }}</span>
      <button v-if="htmlRetryable" type="button" class="preview-stream-btn" @click="retryHtml">
        {{ t("preview.retry") }}
      </button>
    </p>
    <!-- chunked stream: append-only segments + a 1px sentinel inside the scroll container.
         An html entry in rendered mode shows the sandboxed iframe instead (the iframe fetches
         its own copy; the stream only feeds the SOURCE view + copy value). -->
    <template v-if="stream">
      <PreviewHtml
        v-if="htmlRendered"
        :agent-key="htmlAgent!.agentKey"
        :session-id="htmlAgent!.sessionId"
        :path="path ?? filename ?? ''"
        @mint-error="onHtmlMintError"
      />
      <div v-else-if="effectiveMode === 'rendered'" ref="scrollEl" class="preview-md md preview-stream" tabindex="0">
        <div v-for="seg in mdSegs" :key="seg.id" class="preview-seg">
          <template v-if="seg.kind === 'md'"><MdBlock :nodes="seg.nodes as MdNode[]" /></template
          ><template v-else
            ><p class="preview-md-note">{{ segNote(seg.reason) }}</p>
            <pre class="preview-seg-src">{{ seg.text }}</pre>
          </template>
          <p v-if="seg.tailIncomplete" class="preview-md-note">{{ t("preview.streamTailIncomplete") }}</p>
        </div>
        <div ref="sentinelEl" class="preview-stream-sentinel" aria-hidden="true"></div>
      </div>
      <div v-else ref="scrollEl" class="preview-text-body preview-stream" tabindex="0">
        <div v-for="seg in srcSegs" :key="seg.id" class="preview-seg">{{ seg.text }}</div>
        <div ref="sentinelEl" class="preview-stream-sentinel" aria-hidden="true"></div>
      </div>
    </template>
    <template v-else>
      <!-- rendered html: the sandboxed iframe (web-hub-html-preview §5) — lazy PreviewHtml -->
      <PreviewHtml
        v-if="htmlRendered"
        :agent-key="htmlAgent!.agentKey"
        :session-id="htmlAgent!.sessionId"
        :path="path ?? filename ?? ''"
        @mint-error="onHtmlMintError"
      />
      <!-- rendered: `preview-md md` — `md` pulls in transcript.css's shared markdown typography -->
      <div v-else-if="effectiveMode === 'rendered'" class="preview-md md" tabindex="0">
        <MdBlock :nodes="mdNodes!" />
      </div>
      <pre
        v-else
        class="preview-text-body"
        tabindex="0"
      ><HighlightedCode :text="shownSource" :lang="highlightLang" /></pre>
    </template>
    <div v-if="hasActions" class="preview-text-actions">
      <div
        v-if="stream && statusText !== ''"
        class="preview-stream-status"
        role="status"
        aria-live="polite"
        :title="statusText"
      >
        <span>{{ statusText }}</span>
      </div>
      <button
        v-if="stream && (streamState === 'more' || streamState === 'loading' || streamState === 'waiting')"
        type="button"
        class="preview-stream-btn"
        :disabled="streamState !== 'more'"
        @click="emit('load-more')"
      >
        {{ t("preview.streamLoadMore") }}
      </button>
      <button
        v-if="stream && streamState === 'changed'"
        type="button"
        class="preview-stream-btn"
        @click="emit('reopen')"
      >
        {{ t("preview.streamReopen") }}
      </button>
      <button
        v-if="stream && streamState === 'error' && stream.retryable === true"
        type="button"
        class="preview-stream-btn"
        @click="emit('retry-stream')"
      >
        {{ t("preview.streamRetry") }}
      </button>
      <div
        v-if="isMd || htmlOn"
        class="preview-toggle"
        role="group"
        :aria-label="isMd ? t('preview.viewToggleLabel') : t('preview.htmlToggleLabel')"
        :title="mdTooComplex ? t('preview.mdTooComplex') : undefined"
      >
        <button
          type="button"
          class="preview-toggle-btn"
          :aria-pressed="pressedRendered"
          :disabled="mdTooComplex"
          @click="onToggle('rendered')"
        >
          {{ t("preview.viewRendered") }}
        </button>
        <button type="button" class="preview-toggle-btn" :aria-pressed="!pressedRendered" @click="onToggle('source')">
          {{ t("preview.viewSource") }}
        </button>
      </div>
    </div>
  </div>
</template>
