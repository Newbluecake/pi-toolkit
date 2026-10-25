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

  Line numbers (2026-10-23, L1): the SOURCE views (non-stream `<pre>` and the stream's
  `.preview-seg` source segments) show a left gutter by default — one `.pv-line` block per
  logical line, the number a CSS counter in `::before` (never a DOM node: selection and the
  published copy value stay pure body text). The `pwh_linenumbers` browser pref (header
  toggle in PreviewWindow, shared by all windows, default ON) switches back to the exact
  pre-feature DOM. Each line carries its own "\n" terminator so the rendered `textContent`
  stays byte-identical to the legacy body; stream numbering continues across segments
  (precomputed at ingestion, append-only — a §4.3.4 force cut leaves an unnumbered
  continuation head) and degrades to plain `.preview-seg` divs past
  PREVIEW_NUMBERED_LINES_MAX lines (the non-stream view degrades to `<HighlightedCode>` +
  a note). Rendered md/html views never show line numbers. See `@logic/previewLines.ts`.

  preview-perf P3 (plan r3 §4.1/§4.5–§4.8, 2026-10-23): the renderer choice now flows through
  `chooseSourceRenderer` — with the build-time switch on, >600-line non-stream bodies and ALL
  line-numbered streams render through `VirtualCode` (virtual scroll, selection freeze,
  logical Ctrl+A — that component owns those); line numbers off and the per-WINDOW full-view
  escape keep the legacy single-text DOM, byte-identical. The three r0 branches stay alive
  for the kill switch (`virtualEnabled: false` prop / `PREVIEW_VIRTUAL_KEY` provide). This
  component owns the virtual text model (one `createVirtualSourceFactory` per mount; streams
  grow through `append(copyValue)`), the idle main-thread highlight (§5.1 — original gates,
  plain first frame, gesture/scroll-dodging `requestIdleCallback`), the in-window find engine
  (§4.6 — P1's `createPreviewFinder` + the singleton Custom Highlight manager in
  `composables/useFindHighlights.ts`, `PreviewFind.vue` is the bar) and the
  `update:findable` / `update:virtualizable` channels PreviewWindow's Ctrl+F interception and
  完整视图 button consume. The virtual-body highlight itself lives in highlight-core since P5
  (plan §5.3): `createVirtualHighlighter` tokenizes in the shared module WORKER (widened gates
  256 KiB / 80k tokens) and falls back to §5.1's original-gate idle main-thread path whenever
  the worker is unavailable/timed out/errored — this component only supplies the deps above.
-->
<script lang="ts">
import type { InjectionKey } from "vue";
/**
 * preview-perf P3 (plan r3 §4.1/§6.3): the build-time virtual-renderer switch's TEST/PROBE
 * injection. Production reads the constant; tests (and the PB probe page, which provides it
 * from `?virtual=1`) provide `false` to pin the r0 renderer set. Lower priority than the
 * `virtualEnabled` prop.
 */
export const PREVIEW_VIRTUAL_KEY: InjectionKey<boolean> = Symbol("preview-virtual-enabled");

/** Module-scope id sequence for find-highlight owner ids (one owner per PreviewText mount). */
let findUidSeq = 0;
</script>
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
import MdPreviewBody from "./MdPreviewBody.vue";
import type { MdNode } from "../transcript/markdown-types.js";
import HighlightedCode from "../shared/HighlightedCode.vue";
import NumberedCode from "../shared/NumberedCode.vue";
import CodeLines from "../shared/CodeLines.vue";
import { useLineNumbersPref } from "../../composables/useLineNumbersPref.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
import {
  countCodeLines,
  splitTextIntoCodeLines,
  PREVIEW_NUMBERED_LINES_MAX,
  type CodeLine,
} from "@logic/previewLines.js";
import { HUB_CTX } from "../control/controlContext.js";
import { MD_IMAGE_LOADER, PREVIEW_BASE_DIR, PREVIEW_CTX } from "./previewContext.js";
import { createMdImageFetcher, createMdImageLoader } from "../../composables/useMdImageLoader.js";
import { dirOfPreviewPath } from "@logic/mdLinkPath.js";
import type { PreviewTextStream } from "../../types.js";
import { chooseSourceRenderer, type SourceRendererChoice } from "@logic/previewVirtual.js";
import { createVirtualSourceFactory } from "@logic/previewLineIndex.js";
import { createPreviewFinder, type PreviewFinder } from "@logic/previewFind.js";
import { PREVIEW_VIRTUAL_ENABLED, type MutableVirtualSource } from "@logic/previewVirtualTypes.js";
import { createVirtualHighlighter, isImmediateHighlightSize } from "../shared/highlight-core.js";
import VirtualCode from "../shared/VirtualCode.vue";
import PreviewFind from "./PreviewFind.vue";
import { acquireFindHighlights, type FindHighlightHandle } from "../../composables/useFindHighlights.js";
import { PW_DRAGGING_CLASS } from "../../composables/usePreviewWindowLayout.js";

type SourceSegment = ReturnType<ReturnType<typeof createSourceSegmenter>["push"]>[number];
type MdSegment = ReturnType<ReturnType<typeof createMarkdownSegmenter>["push"]>[number];

const props = withDefaults(
  defineProps<{
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
    /** preview-perf P3 §4.7: the PER-WINDOW full-view escape — true renders exactly like line
     *  numbers off (legacy single-text DOM / legacy segments). Owner: PreviewWindow. */
    readonly fullView?: boolean | undefined;
    /** Test seam (plan §4.3): inject the virtual body's row height (happy-dom cannot measure). */
    readonly rowHeight?: number | undefined;
    /** Test seam (plan §4.3): inject the virtual body's viewport height. */
    readonly viewportHeight?: number | undefined;
    /** Test seam (plan §4.1/§6.3): force the r0 renderer set (overrides the injected value;
     *  absent ⇒ `PREVIEW_VIRTUAL_KEY` provide ⇒ the build-time constant). */
    readonly virtualEnabled?: boolean | undefined;
  }>(),
  // EXPLICIT undefined defaults: Vue otherwise Boolean-casts absent optional booleans to
  // `false` — which would silently flip the virtual kill switch OFF on every direct mount.
  // With undefined, absent stays absent and `??` falls through to the injection/constant.
  {
    loadedLabel: undefined,
    totalLabel: undefined,
    stream: undefined,
    filename: undefined,
    path: undefined,
    fullView: undefined,
    rowHeight: undefined,
    viewportHeight: undefined,
    virtualEnabled: undefined,
  },
);
const emit = defineEmits<{
  (e: "load-more"): void;
  (e: "reopen"): void;
  (e: "retry-stream"): void;
  /** 2026-10-20: the copy button lives in PreviewHost's header now — this is the channel the
   *  header's CopyButton reads. Emitted on mount and on every change; `null` on unmount. */
  (e: "update:copyValue", value: string | null): void;
  /** 2026-10-23 (line numbers): whether the current view is a SOURCE view (the header's
   *  行号 toggle only makes sense there — rendered md/html hide it). Immediate, and `false`
   *  on unmount. */
  (e: "update:sourceView", value: boolean): void;
  /** preview-perf P3 §4.6: the CURRENT view is the virtual source view — the only state in
   *  which PreviewWindow intercepts Ctrl/⌘+F. `false` on unmount and whenever the renderer
   *  leaves the virtual path (line numbers off / full view / rendered view). */
  (e: "update:findable", value: boolean): void;
  /** preview-perf P3 §4.7: a virtual source view is AVAILABLE for THIS body (independent of
   *  the current fullView state — the header's 完整视图 button shows while pressed too). */
  (e: "update:virtualizable", value: boolean): void;
}>();
const { t } = useI18n();
const highlightLang = computed(() => resolveFileLang(props.filename ?? ""));
/** P5 addendum (user ruling 2026-10-23, PB-report §7.3): §5.2's first-frame highlight is for
 *  SMALL files only — ≤200 lines and ≤8 KiB. Larger in-gate files render plain first and swap
 *  when the debounced tokenize lands (the pre-§5.2 behaviour); the virtual worker path is
 *  unaffected (it always starts plain and never passes `immediate`). */
const immediateHl = computed(() => isImmediateHighlightSize(shownSource.value));

// --- line numbers (2026-10-23): the browser-local `pwh_linenumbers` pref, shared by every
// open preview window (module-scope ref — a toggle anywhere re-renders all of them). -------
const lnPref = useLineNumbersPref({ storage: browserLocalStorage() });

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

// Stream line numbers: per-segment line data, computed ONCE per segment at ingestion
// (append-only, same discipline as `srcSegs` — old segments are never re-split/re-patched).
// `start` is the first numbered line; `cont` marks a force-cut continuation head (§4.3.4);
// `numbered` flips false for good once the cumulative line count passes
// PREVIEW_NUMBERED_LINES_MAX (that and every later segment render as the legacy plain
// `.preview-seg` div). State precedes `syncStream()` — the setup-time call reads it.
interface SrcLineSeg {
  readonly id: number;
  readonly start: number;
  readonly cont: boolean;
  readonly numbered: boolean;
  readonly text: string;
  readonly lines: readonly CodeLine[];
}
const srcLineSegs = shallowRef<readonly SrcLineSeg[]>([]);
let lnCursor = 0;
let lnNextStart = 1;
let lnCont = false;
let lnNumbered = true;
let lnTotal = 0;

function syncLineSegs(): void {
  if (!lnPref.on.value) return;
  const segs = srcSegs.value;
  if (lnCursor >= segs.length) return;
  const add: SrcLineSeg[] = [];
  while (lnCursor < segs.length) {
    const seg = segs[lnCursor++]!;
    const lines = splitTextIntoCodeLines(seg.text);
    if (lnNumbered && lnTotal + lines.length > PREVIEW_NUMBERED_LINES_MAX) lnNumbered = false;
    lnTotal += lines.length;
    add.push(markRaw({ id: seg.id, start: lnNextStart, cont: lnCont, numbered: lnNumbered, text: seg.text, lines }));
    // next segment's first numbered line: +lines, minus the unnumbered continuation head.
    lnNextStart += lines.length - (lnCont && lines.length > 0 ? 1 : 0);
    // a segment whose consumed text (text+sep) does not end with "\n" leaves its last line
    // unfinished ⇒ the next segment's first line is a continuation. Non-final segments never
    // end with "\n" (§4.3.4), so `sep === ""` is exactly that case.
    lnCont = seg.sep === "";
  }
  srcLineSegs.value = [...srcLineSegs.value, ...add];
}

function syncStream(): void {
  syncSource();
  syncMd();
  syncLineSegs();
}
syncStream();
watch(() => [props.stream?.chunks.length ?? 0, props.stream?.state, effectiveMode.value] as const, syncStream);
// Toggling the pref ON mid-stream catches the line view up from the already-consumed segs.
watch(lnPref.on, (on) => {
  if (on) syncLineSegs();
});

// --- line numbers / preview-perf P3: renderer selection (plan r3 §4.1) ---------------------
// Non-stream: `NumberedCode` (highlight → per-line split) replaces `HighlightedCode` inside
// the SAME `<pre class="preview-text-body">` (DOM/text fidelity pinned by tests: every line
// carries its own "\n", so textContent is byte-identical). The three r0 branches (numbered,
// >8000 degrade + note, per-segment stream CodeLines) stay ALIVE for the build-time kill
// switch (`virtualEnabled: false` ⇒ `chooseSourceRenderer` delegates to them byte-identically);
// with the switch on, >600-line non-stream bodies and ALL line-numbered streams render through
// `VirtualCode` instead (§4.1 table).
const shownLineCount = computed(() => countCodeLines(shownSource.value));

/** The build-time switch's effective value: prop > `PREVIEW_VIRTUAL_KEY` provide > constant. */
const virtualSwitch = inject(PREVIEW_VIRTUAL_KEY, null);
const virtualEnabledOn = computed(() => props.virtualEnabled ?? virtualSwitch ?? PREVIEW_VIRTUAL_ENABLED);
/** The §4.1 table for THIS body (fullView on ⇒ legacy, exactly like line numbers off). */
const rendererChoice = computed<SourceRendererChoice>(() =>
  chooseSourceRenderer(
    {
      lineNumbers: lnPref.on.value,
      fullView: props.fullView === true,
      stream: isStream.value,
      lineCount: shownLineCount.value,
    },
    { virtualEnabled: virtualEnabledOn.value },
  ),
);
const virtualized = computed(() => rendererChoice.value === "virtual");

/** The header's 行号 toggle is offered only while a SOURCE view is actually showing. */
const sourceViewActive = computed(() => !htmlRendered.value && effectiveMode.value === "source");
watch(sourceViewActive, (v) => emit("update:sourceView", v), { immediate: true });
onBeforeUnmount(() => emit("update:sourceView", false));

/** §4.7: a virtual source view is AVAILABLE (computed at `fullView: false` — the 完整视图
 *  button must stay visible while pressed, to un-press it). */
const virtualizable = computed(
  () =>
    sourceViewActive.value &&
    chooseSourceRenderer(
      { lineNumbers: lnPref.on.value, fullView: false, stream: isStream.value, lineCount: shownLineCount.value },
      { virtualEnabled: virtualEnabledOn.value },
    ) === "virtual",
);
watch(virtualized, (v) => emit("update:findable", v), { immediate: true });
watch(virtualizable, (v) => emit("update:virtualizable", v), { immediate: true });
onBeforeUnmount(() => {
  emit("update:findable", false);
  emit("update:virtualizable", false);
});

/** Copy = the ANSI-stripped consumed source (`text + sep` is strictly the stripped input,
 * §4.3.4 — the raw bytes stay downloadable through PreviewHost's own refetch). Line numbers
 * never touch this (they are CSS counters, not DOM). */
const copyValue = computed(() =>
  isStream.value ? srcSegs.value.map((x) => x.text + x.sep).join("") : shownSource.value,
);
// Publish to the header (PreviewHost): immediate so the button appears with the dialog,
// re-emitted as chunks arrive / ANSI carries flush; `null` on unmount clears the header.
watch(copyValue, (v) => emit("update:copyValue", v), { immediate: true });
onBeforeUnmount(() => emit("update:copyValue", null));

// --- preview-perf P3: the virtual text model (plan r3 §4.2/§4.8) ---------------------------
// One source per PreviewText mount (the Host's `:key="view.path"` remounts per file). Non-
// stream bodies build one-shot (`fromText`) and REBUILD on a text change; streams grow
// through `append(copyValue)` — the same ANSI-stripped consumed text that feeds the legacy
// segments and the copy button, so the virtual body, the copy value and find all agree.
// `vRev` is the reactive tick VirtualCode consumes (P2's wiring contract — the model itself
// is a plain frozen-interface object).
const virtualEl = ref<InstanceType<typeof VirtualCode> | null>(null);
/** VirtualCode's optional geometry props omit their keys when unprovided
 *  (`exactOptionalPropertyTypes` — a `number | undefined` value would not be assignable). */
const virtualGeometry = computed((): { rowHeight?: number; viewportHeight?: number } => ({
  ...(props.rowHeight !== undefined ? { rowHeight: props.rowHeight } : {}),
  ...(props.viewportHeight !== undefined ? { viewportHeight: props.viewportHeight } : {}),
}));
const vFactory = createVirtualSourceFactory();
let vSource: MutableVirtualSource | null = null;
const vRev = ref(0);
if (isStream.value) {
  vSource = vFactory.forStream();
  // The stream section above has already consumed the current chunks at setup — seed the
  // model with them (the watcher below only fires on CHANGE).
  if (copyValue.value.length > 0) vSource.append(copyValue.value);
  vRev.value = vSource.revision;
} else {
  vSource = vFactory.fromText(shownSource.value);
  vRev.value = vSource.revision;
}

/** Stream: the consumed source grew — append + bump the tick (§4.8 scans only the delta).
 *  NOT gated on `virtualized`: the model must stay current while a rendered view / full view
 *  shows, or switching back would silently miss everything appended in the meantime. */
watch(copyValue, (v) => {
  if (!isStream.value || vSource === null) return;
  if (v !== vSource.text()) vSource.append(v);
  vRev.value = vSource.revision;
  if (findOpen.value && finder.query !== "") {
    finder.append(vSource.text());
    afterFindTextChange();
  }
});

/** Non-stream: a whole-text change (same-path retry) is a REBUILD, never an append. */
if (!isStream.value) {
  watch(shownSource, (t) => {
    if (vSource === null) return;
    vSource = vFactory.fromText(t);
    vRev.value = vSource.revision;
    virtualHighlighter.schedule(); // bumps the epoch — a pending tokenize for the OLD text is dropped
    if (findOpen.value && finder.query !== "") {
      finder.search(finder.query, finder.caseSensitive, t);
      afterFindTextChange();
    }
  });
}

// --- preview-perf P5 §5.3: the virtual-body highlighter (worker first, §5.1 fallback) -----
// The whole orchestration now lives in highlight-core (`createVirtualHighlighter` — P5's
// "虚拟入口"): the body tokenizes in the shared same-origin module WORKER under the widened
// gates (256 KiB / lines uncapped / 80k tokens), and whenever the worker is out (sticky
// unavailable / CSP-blocked / this request's 3 s deadline) it runs §5.1's path VERBATIM —
// idle main-thread tokenization under the ORIGINAL gates (100 KiB / 3000 / 20k). This
// component now only supplies text/lang/activity, the apply sink and the §5.1 dodge signal.
// Streams never highlight (§5.3 — the body keeps growing; same as r0).
let lastScrollAt = 0;
function onDocScrollCapture(): void {
  lastScrollAt = Date.now();
}

const virtualHighlighter = createVirtualHighlighter({
  text: () => shownSource.value,
  lang: () => highlightLang.value,
  active: () => virtualized.value && !isStream.value,
  apply: (spans) => {
    if (vSource === null) return;
    vSource.setHighlight(spans); // repaints the mounted blocks only (P2 contract)
    vRev.value = vSource.revision;
  },
  busy: () =>
    (typeof document !== "undefined" && document.body.classList.contains(PW_DRAGGING_CLASS)) ||
    Date.now() - lastScrollAt < 150,
});

onMounted(() => {
  if (typeof document !== "undefined") {
    document.addEventListener("scroll", onDocScrollCapture, { passive: true, capture: true });
  }
  virtualHighlighter.schedule();
});
onBeforeUnmount(() => {
  virtualHighlighter.dispose(); // window closed — pending tasks are cancelled outright
  if (typeof document !== "undefined") {
    document.removeEventListener("scroll", onDocScrollCapture, true);
  }
});
watch(virtualized, (on) => {
  if (on) virtualHighlighter.schedule();
  else virtualHighlighter.invalidate(); // left the virtual path — a pending tokenize is stale
});

// --- preview-perf P3 §4.6: the in-window find ----------------------------------------------
// The ENGINE (P1's `createPreviewFinder`: greedy hits, length-preserving fold, incremental
// append/flush) and the RANGE painter live here; PreviewFind is presentation + input keys.
// Ctrl/⌘+F itself is intercepted at PreviewWindow's panel root (§4.6's focus rules) and
// reaches this component through the exposed `openFind()`.
const findOwnerId = `pv-find-owner-${(findUidSeq += 1)}`;
const findOpen = ref(false);
const findQuery = ref("");
const findCase = ref(false);
const findCount = ref(0);
const findCurrent = ref(0); // 1-based; 0 = none selected
const findMore = ref(false);
const findBeyond = ref(false);
const finder: PreviewFinder = createPreviewFinder();
const findBarEl = ref<InstanceType<typeof PreviewFind> | null>(null);
let findOwner: FindHighlightHandle | null = null;
let findTimer: ReturnType<typeof setTimeout> | undefined;

/** §4.6 entry: open (or re-focus) the bar with the input selected. Virtual views only. */
function openFind(): void {
  if (!virtualized.value) return;
  findOpen.value = true;
  void nextTick(() => findBarEl.value?.focusSelect());
}

/** Esc / × — only the bar closes; the scroll body takes focus back (§4.6). */
function closeFind(): void {
  findOpen.value = false;
  findOwner?.setRanges([], null);
  if (findTimer !== undefined) {
    clearTimeout(findTimer);
    findTimer = undefined;
  }
  const el = virtualEl.value?.scrollEl;
  if (el instanceof HTMLElement) el.focus();
}

function ensureFindOwner(): void {
  findOwner ??= acquireFindHighlights(findOwnerId); // null on engines without the API (K9)
}

/** Query / case flips: full re-search after the 120 ms debounce (§4.6), current hit lands on
 *  the first hit at-or-below the viewport top. */
watch([findQuery, findCase], () => {
  if (!findOpen.value) return;
  if (findTimer !== undefined) clearTimeout(findTimer);
  findTimer = setTimeout(runFindSearch, 120);
});

function runFindSearch(): void {
  if (vSource === null) return;
  finder.search(findQuery.value, findCase.value, vSource.text());
  afterFindUpdate(true);
}

/** Text grew (stream append) / terminal flush: incremental protocol keeps the current hit. */
function afterFindTextChange(): void {
  afterFindUpdate(false);
}

function afterFindUpdate(pickInitial: boolean): void {
  findCount.value = finder.hits.length;
  findMore.value = finder.more;
  if (pickInitial) pickInitialCurrent();
  findCurrent.value = finder.currentIndex() + 1;
  updateFindBeyond();
  void nextTick(rebuildFindRanges);
}

/** First hit ≥ the viewport's top line (§4.6 当前项初始): the first MOUNTED block's start is
 *  the available proxy for the viewport top (blocks cover the viewport ± overscan). */
function viewportTopLine(): number {
  const first = virtualEl.value?.scrollEl?.querySelector<HTMLElement>(".pv-vblock[data-start]");
  const s = Number(first?.dataset.start ?? "1");
  return Number.isFinite(s) && s >= 1 ? s : 1;
}

function pickInitialCurrent(): void {
  const hits = finder.hits;
  if (hits.length === 0 || vSource === null) {
    finder.setCurrent(-1);
    return;
  }
  const off = vSource.lineStart(Math.min(viewportTopLine() - 1, vSource.lineCount));
  let a = 0;
  let b = hits.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if ((hits[m] as number) < off) a = m + 1;
    else b = m;
  }
  finder.setCurrent(hits[Math.min(a, hits.length - 1)] as number);
}

function updateFindBeyond(): void {
  findBeyond.value = false;
  const idx = finder.currentIndex();
  if (idx < 0 || vSource === null) return;
  const start = finder.hits[idx] as number;
  const line = vSource.lineOf(start);
  const dl = vSource.displayLine(line);
  let visible = 0;
  for (const p of dl.parts) visible += p.text.length;
  findBeyond.value = start + Math.max(1, finder.query.length) > vSource.lineStart(line) + visible;
}

/** Enter / F3 / ⌘G / buttons — wrap around; scroll the hit's line to center, repaint. */
function findNav(dir: 1 | -1): void {
  const n = finder.hits.length;
  if (n === 0 || vSource === null) return;
  const next = (((finder.currentIndex() + dir) % n) + n) % n;
  const start = finder.hits[next] as number;
  finder.setCurrent(start);
  findCurrent.value = next + 1;
  updateFindBeyond();
  virtualEl.value?.scrollToLine(vSource.lineOf(start) + 1, "center");
  void nextTick(rebuildFindRanges);
}

/** First hit start ≥ `x` (hits are sorted). */
function lowerBoundHit(hits: readonly number[], x: number): number {
  let a = 0;
  let b = hits.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if ((hits[m] as number) < x) a = m + 1;
    else b = m;
  }
  return a;
}

function textNodesIn(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) out.push(n as Text);
  return out;
}

/** One hit's DOM Range inside a mounted line element, CLAMPED to the displayed prefix —
 *  a hit in a clipped line's hidden tail marks to the clip point (§4.6 截断区命中); one
 *  entirely past it collapses at the cut (nothing to paint — the count annotates instead).
 *  Text nodes map 1:1 onto source offsets: parts render source-order text verbatim and the
 *  query is newline-stripped, so a hit never crosses a line boundary. */
function buildFindRange(lineEl: HTMLElement, lineOff: number, displayLen: number, s: number, e: number): Range {
  const range = document.createRange();
  const nodes = textNodesIn(lineEl);
  const place = (pos: number, isStart: boolean): void => {
    const rel = Math.max(0, Math.min(pos - lineOff, displayLen));
    let cum = 0;
    for (const node of nodes) {
      const len = node.data.length;
      if (rel <= cum + len) {
        if (isStart) range.setStart(node, rel - cum);
        else range.setEnd(node, rel - cum);
        return;
      }
      cum += len;
    }
    const last = nodes[nodes.length - 1];
    if (last !== undefined) {
      if (isStart) range.setStart(last, last.data.length);
      else range.setEnd(last, last.data.length);
    } else {
      if (isStart) range.setStart(lineEl, 0);
      else range.setEnd(lineEl, 0);
    }
  };
  const cs = Math.max(s, lineOff);
  const ce = Math.min(e, lineOff + displayLen);
  if (ce <= cs) {
    place(lineOff + displayLen, true); // zero-width at the clip point
    place(lineOff + displayLen, false);
    return range;
  }
  place(cs, true);
  place(ce, false);
  return range;
}

/** Post-flush repaint: build a Range for every hit inside a MOUNTED block and hand them to
 *  the singleton Custom Highlight manager (union across windows). Without the API (K9) the
 *  CURRENT hit becomes the native selection instead — §4.5's selection rules then apply by
 *  design. Hits on unmounted lines simply have no range until scrolled near. */
function rebuildFindRanges(): void {
  if (!findOpen.value || vSource === null) return;
  const pre = virtualEl.value?.scrollEl ?? null;
  if (finder.query === "" || pre === null) {
    findOwner?.setRanges([], null);
    return;
  }
  ensureFindOwner();
  const qLen = finder.query.length;
  const curIdx = finder.currentIndex();
  const hits = finder.hits;
  const all: Range[] = [];
  let curRange: Range | null = null;
  for (const block of Array.from(pre.querySelectorAll<HTMLElement>(".pv-vblock"))) {
    const startLine = Number(block.dataset.start ?? "-1") - 1;
    if (!Number.isFinite(startLine) || startLine < 0) continue;
    const lineEls = Array.from(block.children) as HTMLElement[];
    for (let k = 0; k < lineEls.length; k++) {
      const li = startLine + k;
      const dl = vSource.displayLine(li);
      const lineOff = vSource.lineStart(li);
      let displayLen = 0;
      for (const p of dl.parts) displayLen += p.text.length;
      let a = lowerBoundHit(hits, lineOff);
      while (a < hits.length && (hits[a] as number) < lineOff + displayLen) {
        const hs = hits[a] as number;
        const r = buildFindRange(lineEls[k] as HTMLElement, lineOff, displayLen, hs, hs + qLen);
        all.push(r);
        if (a === curIdx) curRange = r;
        a++;
      }
    }
  }
  if (findOwner !== null) {
    findOwner.setRanges(all, curRange);
  } else if (curRange !== null) {
    const sel = document.getSelection();
    if (sel !== null) {
      sel.removeAllRanges();
      sel.addRange(curRange);
    }
  }
}

// The mounted set changes on scroll/resize — repaint the hit marks post-flush (§4.6).
watch(virtualEl, (vc, _old, onCleanup) => {
  const el = vc?.scrollEl;
  if (!(el instanceof HTMLElement)) return;
  const onScroll = (): void => {
    void nextTick(rebuildFindRanges);
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  onCleanup(() => el.removeEventListener("scroll", onScroll));
});
watch(vRev, () => {
  if (findOpen.value && finder.query !== "") void nextTick(rebuildFindRanges);
});
// Stream terminal state: flush the fold's trailing surrogate carry into findable hits (§4.6).
// (Reads `props.stream?.state` directly — `terminal` is defined further down the setup.)
watch(
  () => props.stream?.state,
  (st) => {
    if ((st === "done" || st === "cap" || st === "changed") && findOpen.value && finder.query !== "") {
      finder.flush();
      afterFindTextChange();
    }
  },
);
// Leaving the virtual path (full view / line numbers off / view switch) closes the bar.
watch(virtualized, (on) => {
  if (!on && findOpen.value) {
    findOpen.value = false;
    findOwner?.setRanges([], null);
  }
});
onBeforeUnmount(() => findOwner?.release());

defineExpose({ openFind });

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
  // The scroll container differs per renderer branch: the virtual body's `<pre>` lives inside
  // VirtualCode (exposed as `scrollEl`, §4.8 — the sentinel rides its default slot); every
  // legacy branch owns its own `scrollEl` template ref.
  const root = virtualEl.value?.scrollEl ?? scrollEl.value;
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
// the scroll container is a different element per view mode / renderer branch — re-observe
// after the swap (the virtual ⇄ legacy flips ride `rendererChoice`; md/html ride `effectiveMode`)
watch([effectiveMode, rendererChoice], () => void nextTick(observe));
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
    <!-- line numbers: the toggle is on but the body is over PREVIEW_NUMBERED_LINES_MAX ⇒
         the legacy single-block body renders instead, with this one-line reason (preview-perf
         P3: only reachable on the r0 path — with the virtual switch on, >600-line bodies go
         virtual long before the 8000-line degrade). -->
    <p v-if="!stream && sourceViewActive && rendererChoice === 'numbered-capped'" class="preview-md-note" role="note">
      {{ t("preview.linesTooMany", { n: String(PREVIEW_NUMBERED_LINES_MAX) }) }}
    </p>
    <!-- web-hub-html-preview §5: a failed html mint keeps the source view usable and explains
         itself in one line (403 dir-too-broad/upload ⇒ the prose variant); retryable errors
         get a retry that flips back to rendered (remount ⇒ re-mint). -->
    <p v-if="htmlOn && htmlDenied !== null" class="preview-md-note" role="note">
      <span>{{ htmlNoteText }}</span>
      <button v-if="htmlRetryable" type="button" class="preview-stream-btn" @click="retryHtml">
        {{ t("preview.retry") }}
      </button>
    </p>
    <!-- preview-perf P3 §4.6: the in-window find bar (virtual source views only; opened by
         PreviewWindow's Ctrl/⌘+F interception → exposed openFind()). -->
    <PreviewFind
      v-if="findOpen && virtualized"
      ref="findBarEl"
      :query="findQuery"
      :case-sensitive="findCase"
      :count="findCount"
      :current="findCurrent"
      :more="findMore"
      :has-query="findQuery !== ''"
      :beyond-display="findBeyond"
      @update:query="findQuery = $event"
      @update:case-sensitive="findCase = $event"
      @next="findNav(1)"
      @prev="findNav(-1)"
      @close="closeFind"
    />
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
      <!-- preview-perf P3 §4.1/§4.8: a line-numbered stream is ALWAYS virtual (no mid-stream
           renderer switch). The sentinel rides VirtualCode's default slot — after the spacer,
           inside the scroll container; the stream state lines stay in the actions row below. -->
      <VirtualCode
        v-else-if="virtualized"
        ref="virtualEl"
        :source="vSource!"
        :source-revision="vRev"
        v-bind="virtualGeometry"
      >
        <div ref="sentinelEl" class="preview-stream-sentinel" aria-hidden="true"></div>
      </VirtualCode>
      <div v-else ref="scrollEl" class="preview-text-body preview-stream" tabindex="0">
        <!-- line numbers on (default): one CodeLines block per segment (its root carries
             the legacy `preview-seg` class), keyed + precomputed so old segments are never
             re-patched; over the line cap a segment falls back to the plain div. Off: the
             exact pre-feature DOM. (r0 path — reached when the virtual switch is off, or
             line numbers/full view force legacy.) -->
        <template v-if="rendererChoice === 'stream-lines'">
          <template v-for="seg in srcLineSegs" :key="seg.id"
            ><CodeLines
              v-if="seg.numbered"
              class="preview-seg"
              :lines="seg.lines"
              :start-line="seg.start"
              :continuation="seg.cont"
            />
            <div v-else class="preview-seg">{{ seg.text }}</div></template
          >
        </template>
        <template v-else
          ><div v-for="seg in srcSegs" :key="seg.id" class="preview-seg">{{ seg.text }}</div></template
        >
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
      <!-- rendered: `preview-md md` — `md` pulls in transcript.css's shared markdown typography.
           J1 #5: the body mounts progressively (MdPreviewBody — leading blocks first, idle
           batches after; final DOM identical). -->
      <div v-else-if="effectiveMode === 'rendered'" class="preview-md md" tabindex="0">
        <MdPreviewBody :nodes="mdNodes!" />
      </div>
      <!-- preview-perf P3 §4.1: >600 lines (line numbers on) ⇒ VirtualCode. -->
      <VirtualCode
        v-else-if="virtualized"
        ref="virtualEl"
        :source="vSource!"
        :source-revision="vRev"
        v-bind="virtualGeometry"
      />
      <!-- line numbers on (default) + under the line cap ⇒ NumberedCode (per-line split,
           textContent-identical); off / capped ⇒ the exact pre-feature HighlightedCode.
           `immediate` (preview-perf §5.2 + P5 addendum): SMALL files only (≤200 lines / ≤8 KiB
           — PB-report §7.3's regression) get the highlighted first render; larger in-gate
           files render plain and swap when the debounced tokenize lands. -->
      <pre
        v-else
        class="preview-text-body"
        tabindex="0"
      ><NumberedCode v-if="rendererChoice === 'numbered'" :text="shownSource" :lang="highlightLang" :immediate="immediateHl" /><HighlightedCode v-else :text="shownSource" :lang="highlightLang" :immediate="immediateHl" /></pre>
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
