<!--
  Mermaid diagram block (web-hub-mermaid plan §6.3, P2; r3 主会话裁定 + r3 补充/补充二适用).
  `MdBlock.vue` routes every `isMermaidFence` fence here. Two regimes:

  - STREAMING (`PATH_REFERENCES_SUSPENDED` provided true — the message is still settling): render
    `<CodeBlock>` verbatim so the streaming DOM stays byte-identical to today's (r3 补充: 流式中
    保持原 CodeBlock DOM 逐字节不变). No request is ever made while streaming.
  - SETTLED: `idle → (visible) loading → ok | error` on `data-mmd-state`. Mount peeks the runtime
    cache synchronously (a hit shows the terminal state directly — no source flash); otherwise an
    IntersectionObserver (rootMargin 800px; no IO in the environment ⇒ request immediately) gates
    the render. Results are generation-guarded (§4.5): every new request (visibility, text change
    — debounced 300 ms —, theme change) aborts the previous AbortController and bumps `gen`; a
    result is applied only if its generation is still current and the component is not unmounted.

  Views: diagram (`<img>` from the runtime's data-URL SVG, `max-width:100%; height:auto`) ⇄ source
  (`<pre>` + coarse clamp, same chrome as CodeBlock). The 「原尺寸 ⇄ 适应宽度」 button appears only
  while the diagram is intrinsically wider than the figure container (and ≤8192px); per r3 补充二
  the container carries a ResizeObserver so a later window/panel resize re-decides the button.
  Copy always copies the source; when the clipboard fails in diagram view it first switches to the
  source view, waits a tick, then selects the `<pre>` (#11) — never requestAnimationFrame.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { MermaidBlockProps } from "../../contracts.js";
import { useCoarseClamp } from "../../composables/useCoarseClamp.js";
import { useClipboard } from "../../composables/useClipboard.js";
import { useEffectiveDark } from "../../composables/useEffectiveDark.js";
import { useI18n } from "../../composables/useI18n.js";
import { PATH_REFERENCES_SUSPENDED } from "../preview/previewContext.js";
import {
  peekMermaidCache,
  requestMermaid,
  type MermaidErrorReason,
  type MermaidOutcome,
  type MermaidTheme,
} from "../shared/mermaid-runtime.js";
import AppIcon from "../../icons/AppIcon.vue";
import CodeBlock from "./CodeBlock.vue";
import ClampToggle from "./ClampToggle.vue";
import "../../styles/mermaid.css";

const props = defineProps<MermaidBlockProps>();
const { t } = useI18n();

/* --- streaming gate (plan §6.3: the provided flag is the "message still streaming" signal) --- */
const suspendedInjected = inject(PATH_REFERENCES_SUSPENDED, null);
const streaming = computed(() => suspendedInjected?.value === true);

/* --- theme (plan §6.1: effective dark = html.theme-dark | (no theme-light ∧ OS dark)) -------- */
const effectiveDark = useEffectiveDark();
const theme = computed<MermaidTheme>(() => (effectiveDark.value ? "dark" : "light"));

/* --- state machine: idle → (visible) loading → ok | error ---------------------------------- */
type Phase = "idle" | "loading" | "ok" | "error";
type OkResult = Extract<MermaidOutcome, { kind: "ok" }>;
const phase = ref<Phase>("idle");
const result = ref<OkResult | null>(null);
const errorText = ref("");
const view = ref<"diagram" | "source">("diagram");
const actual = ref(false);
const fitAvailable = ref(false);
const visible = ref(false);

/* --- request generations (§4.5) -------------------------------------------------------------- */
let gen = 0;
let disposed = false;
let controller: AbortController | null = null;
let activeKey: string | null = null;
let textTimer: ReturnType<typeof setTimeout> | undefined;

const rootEl = ref<HTMLElement | null>(null);
const preEl = ref<HTMLElement | null>(null);
const figureEl = ref<HTMLElement | null>(null);

/** §6.2/#11: reason → i18n line. parse/render/timeout/output-invalid share `mermaidError`
 *  (the runtime's ≤160-char message rides along); `unsupported` with a KaTeX-bearing message
 *  selects `mermaidMath` (the runtime maps the KaTeX stub's throw to `unsupported`). */
function errorLine(reason: MermaidErrorReason, message: string): string {
  switch (reason) {
    case "too-large":
      return t("transcript.mermaidTooLarge");
    case "unsupported":
      return /katex|math/i.test(message) ? t("transcript.mermaidMath") : t("transcript.mermaidUnsupported");
    case "busy":
      return t("transcript.mermaidBusy");
    case "load-failed":
    case "engine-unavailable":
      return t("transcript.mermaidLoadFailed");
    default:
      // parse / render / timeout / output-invalid (img @error passes the reason token itself)
      return t("transcript.mermaidError", { message: message.length > 0 ? message : reason });
  }
}

function applyOutcome(myGen: number, outcome: MermaidOutcome): void {
  if (disposed || myGen !== gen) return; // §4.5: stale generation — drop silently
  if (outcome.kind === "ok") {
    result.value = outcome;
    phase.value = "ok";
    return;
  }
  if (outcome.kind === "error") {
    phase.value = "error";
    errorText.value = errorLine(outcome.reason, outcome.message);
  }
  // "cancelled": our own supersession/unmount already handled state — never apply
}

function request(): void {
  const text = props.text;
  const key = `${theme.value}\n${text}`;
  if (key === activeKey && phase.value !== "idle") return; // already settled/in-flight for this key
  activeKey = key;
  controller?.abort();
  controller = new AbortController();
  const myGen = ++gen;

  const cached = peekMermaidCache(text, theme.value);
  if (cached !== undefined && cached.kind !== "cancelled") {
    applyOutcome(myGen, cached);
    return;
  }
  phase.value = "loading";
  result.value = null;
  fitAvailable.value = false;
  requestMermaid({ text, theme: theme.value, signal: controller.signal }).then((outcome) => {
    applyOutcome(myGen, outcome);
  });
}

function ensureRequest(): void {
  if (disposed || streaming.value || !visible.value) return;
  request();
}

/* --- mount: synchronous cache peek, then visibility gating ---------------------------------- */
if (!streaming.value) {
  const cached = peekMermaidCache(props.text, theme.value);
  if (cached !== undefined && cached.kind !== "cancelled") applyOutcome(gen, cached);
}

let io: IntersectionObserver | null = null;

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    visible.value = true;
    ensureRequest();
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      visible.value = true;
      io?.disconnect();
      io = null;
      ensureRequest();
    },
    { rootMargin: "800px" },
  );
  io.observe(rootEl.value as HTMLElement);
});

/* --- reactivity: settle flip, theme, text (debounced 300 ms — plan §6.3) -------------------- */
watch(streaming, (s) => {
  if (!s) ensureRequest();
});
watch(theme, () => {
  ensureRequest(); // §4.5: new key per theme; light→dark→light each hits its own cache entry
});
watch(
  () => props.text,
  () => {
    if (textTimer !== undefined) clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      textTimer = undefined;
      view.value = "diagram"; // new fence content — restart in diagram view
      actual.value = false;
      ensureRequest();
    }, 300);
  },
);

/* --- 「原尺寸」 button width watch (r3 补充二: ResizeObserver on .mmd-figure) ---------------- */
const MAX_ACTUAL_WIDTH_PX = 8192; // plan D3: beyond this the intrinsic size is refused outright
/** `.mmd-figure` horizontal padding (var(--sp-3) both sides) — clientWidth includes it. */
const FIGURE_PADDING_X = 24;
let ro: ResizeObserver | null = null;
let roTarget: HTMLElement | null = null;
/** Last content-box width the RO reported (entries carry the content box — no padding math). */
let roWidth: number | null = null;

function measureFit(entries?: ReadonlyArray<{ contentRect: { width: number } }>): void {
  if (phase.value !== "ok" || result.value === null) {
    fitAvailable.value = false;
    return;
  }
  const last = entries?.[entries.length - 1];
  if (last !== undefined && Number.isFinite(last.contentRect.width) && last.contentRect.width > 0) {
    roWidth = last.contentRect.width;
  }
  let content: number;
  if (roWidth !== null) content = roWidth;
  else {
    const cw = figureEl.value?.clientWidth ?? 0;
    content = cw > 0 ? cw - FIGURE_PADDING_X : 0; // clientWidth is the padding box
  }
  const w = result.value.width;
  fitAvailable.value = w > content + 1 && w <= MAX_ACTUAL_WIDTH_PX;
}

function observeFigure(): void {
  if (ro === null) return;
  const el = figureEl.value;
  if (el === roTarget) return;
  if (roTarget !== null) ro.unobserve(roTarget);
  roTarget = el;
  if (el !== null) ro.observe(el);
}

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") ro = new ResizeObserver((entries) => measureFit(entries));
  observeFigure();
  measureFit();
});
watch(
  figureEl,
  () => {
    observeFigure();
    if (ro === null) measureFit();
  },
  { flush: "post" },
);
watch([phase, view, result], () => measureFit(), { flush: "post" });

/* --- copy (#11): clipboard → on failure switch to source, nextTick, select ------------------ */
const clipboard = useClipboard(window);
const copyStatus = ref<"" | "copied" | "selected" | "select-failed">("");
let copyTimer: ReturnType<typeof setTimeout> | undefined;

function armCopyTimer(): void {
  if (copyTimer !== undefined) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyStatus.value = "";
    copyTimer = undefined;
  }, 2000);
}

async function copy(): Promise<void> {
  const res = await clipboard.copy(props.text);
  if (res.ok) {
    copyStatus.value = "copied";
    armCopyTimer();
    return;
  }
  // 图视图下复制失败：先切到源码再选中（#11 — nextTick, never requestAnimationFrame）
  if (phase.value === "ok" && view.value === "diagram") view.value = "source";
  await nextTick();
  const pre = preEl.value;
  if (pre !== null && typeof document.createRange === "function") {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = document.getSelection();
    if (sel !== null) {
      sel.removeAllRanges();
      sel.addRange(range);
      copyStatus.value = "selected";
      armCopyTimer();
      return;
    }
  }
  copyStatus.value = "select-failed";
  armCopyTimer();
}

/* --- interactions --------------------------------------------------------------------------- */
function toggleView(): void {
  if (phase.value !== "ok" && phase.value !== "loading") return;
  view.value = view.value === "diagram" ? "source" : "diagram";
  if (view.value === "diagram") actual.value = false;
}

function toggleActual(): void {
  actual.value = !actual.value;
  if (actual.value) figureEl.value?.scrollTo?.({ left: 0 });
}

function onImgError(): void {
  if (phase.value !== "ok") return;
  phase.value = "error"; // plan §6.3: an img decode failure counts as output-invalid
  errorText.value = errorLine("output-invalid", "");
}

/* --- coarse-pointer clamp for the source view (same chrome as CodeBlock) --------------------- */
const clamp = useCoarseClamp(() => preEl.value, [() => props.text]);

/* --- teardown -------------------------------------------------------------------------------- */
onBeforeUnmount(() => {
  disposed = true;
  gen += 1; // drop any in-flight settlement (double insurance on top of `disposed`)
  controller?.abort();
  controller = null;
  io?.disconnect();
  io = null;
  ro?.disconnect();
  ro = null;
  roTarget = null;
  if (textTimer !== undefined) clearTimeout(textTimer);
  if (copyTimer !== undefined) clearTimeout(copyTimer);
});

/* --- derived template state ------------------------------------------------------------------- */
const showSource = computed(() => phase.value !== "ok" || view.value === "source");
const canToggleView = computed(() => phase.value === "ok" || phase.value === "loading");
const fitButtonVisible = computed(() => phase.value === "ok" && view.value === "diagram" && fitAvailable.value);
const statusText = computed(() => {
  if (copyStatus.value === "copied") return t("transcript.copyCopied");
  if (copyStatus.value === "selected") return t("transcript.copySelected");
  if (copyStatus.value === "select-failed") return t("transcript.mermaidCopySelectFailed");
  return phase.value === "loading" ? t("transcript.mermaidRendering") : "";
});
const altText = computed(() => {
  const r = result.value;
  return r === null ? "" : (r.title ?? t("transcript.mermaidAlt", { type: r.diagramType }));
});
</script>

<template>
  <CodeBlock v-if="streaming" :lang="lang" :text="text" />
  <div v-else ref="rootEl" class="codeblock mmd" :data-mmd-state="phase" :data-cc="clamp.dataCc">
    <div class="codeblock-head">
      <span translate="no">{{ lang }}</span>
      <span class="mmd-spacer"></span>
      <span v-if="statusText" class="codeblock-status" role="status">{{ statusText }}</span>
      <span class="mmd-actions">
        <button
          v-if="canToggleView"
          class="btn btn-ghost btn-xs"
          type="button"
          :aria-pressed="view === 'source' ? 'true' : 'false'"
          @click="toggleView"
        >
          {{ view === "diagram" ? t("transcript.mermaidShowSource") : t("transcript.mermaidShowDiagram") }}
        </button>
        <button
          v-if="fitButtonVisible"
          class="btn btn-ghost btn-xs"
          type="button"
          :aria-pressed="actual ? 'true' : 'false'"
          @click="toggleActual"
        >
          {{ actual ? t("transcript.mermaidFitWidth") : t("transcript.mermaidActualSize") }}
        </button>
        <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('transcript.copyCode')" @click="copy">
          <AppIcon name="copy" />
        </button>
      </span>
    </div>
    <pre v-if="showSource" ref="preEl" translate="no" tabindex="0" :data-cc="clamp.dataCc"><code>{{ text }}</code></pre>
    <div v-else ref="figureEl" class="mmd-figure" :class="{ actual }" :tabindex="actual ? '0' : undefined">
      <img
        v-if="result"
        :src="result.src"
        :width="result.width"
        :height="result.height"
        :alt="altText"
        decoding="async"
        @error="onImgError"
      />
    </div>
    <ClampToggle :clamp="clamp" />
    <div v-if="phase === 'error'" class="mmd-error">{{ errorText }}</div>
  </div>
</template>
