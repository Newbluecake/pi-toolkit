<!--
  Path-ref segment renderer (web-hub-preview plan v3 §4.6, package PV5). Splits plain text
  with PV4's `findPathRefs` (the frozen §4.6 recognition rules) and renders clickable segments
  as `span.path-ref[role=button][tabindex=0]`; with `code` set, the WHOLE text is one
  inline-code candidate (`pathRefOfCode`) rendered as `code.md-code[.path-ref]` — the exact
  element `MdInline.vue` renders today, so a non-clickable code span is DOM-identical too.

  DOM-equivalence rule (§4.6): with no `PREVIEW_CTX`, `scope === null`, `noRefs`, or
  `PATH_REFERENCES_SUSPENDED` (TxAssistant's streaming flag), the output is the SAME bare
  text node / bare `code.md-code` the transcript renders today — no wrapper, no extra spans.
  Click and Enter/Space (native button grammar on `role="button"`) open the preview through
  the App-level `usePreview` handle; the `:line[:col]` display suffix stays in the visible
  text but is stripped from the request path (§4.6 rule 3).

  2026-10-07 修订「先探测后标记」: when the handle carries `probe` (the transport implements
  `POST /api/preview/probe`), a recognized candidate is NO LONGER clickable on sight — it
  renders plain text until the backend confirms the resource exists and sniffs text/image
  (`stateOf(path) === "confirmed"`); pending/missing/failed all keep the plain rendering
  (identical DOM to today's non-ref segments). Candidates are submitted once per render tick
  through `probe.ensure(...)` — one message's segments merge into ONE batched request in the
  composable. Without `probe` the legacy always-clickable behavior is byte-identical.
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { findPathRefs, pathRefOfCode } from "@logic/preview.js";
import { findProxyUrlRefs, normalizeProxyHref } from "@logic/proxy.js";
import { useI18n } from "../../composables/useI18n.js";
import { useProxyOpen } from "../../composables/useProxyOpen.js";
import { PROXY_PREVIEW_CTX } from "../proxy/proxyPreviewContext.js";
import { PATH_REFERENCES_SUSPENDED, PREVIEW_CTX } from "./previewContext.js";
import "../../styles/proxy.css";

const props = defineProps<{
  readonly text: string;
  /** Inline-code mode: the whole text is the candidate; renders `code.md-code` (MdInline's use). */
  readonly code?: boolean | undefined;
  /** Force plain rendering (equivalent to having no scope). */
  readonly noRefs?: boolean | undefined;
}>();

const ctx = inject(PREVIEW_CTX, null);
const suspended = inject(PATH_REFERENCES_SUSPENDED, null);

const scope = computed(() => ctx?.handle.scope.value ?? null);

/* web-hub-proxy plan v2 §8 (X2): local / private-LAN `http://` URLs become 「open via proxy」
 * affordances — only with the hub's proxy cap (no scope ⇒ every branch below is untouched and
 * the DOM is identical). Independent of the preview scope; suppressed while streaming / noRefs. */
const { t } = useI18n();
const proxy = useProxyOpen();
/** LP3: the App-level in-page preview (absent ⇒ the X2 new-tab flow everywhere below). */
const proxyPreview = inject(PROXY_PREVIEW_CTX, null);
const proxyActive = computed(() => proxy.scope.value !== null && props.noRefs !== true && suspended?.value !== true);
const NOTE_MS = 8000;
const note = ref<{ href: string; key: string | null; url: string | null } | null>(null);
const noteList = computed(() => (note.value === null ? [] : [note.value]));
let noteTimer: ReturnType<typeof setTimeout> | undefined;

function clearNote(): void {
  if (noteTimer !== undefined) clearTimeout(noteTimer);
  noteTimer = undefined;
  note.value = null;
}

/** MUST run synchronously inside the click handler: `proxy.open` calls `window.open` before awaiting. */
function openProxy(href: string, ev?: MouseEvent): void {
  // link-preview §4.1 (LP3, tier 3): with the frame cap a PLAIN click / Enter / Space opens
  // the in-page dialog (no `window.open` on that path — popup blockers don't apply, so the
  // handler no longer needs to be synchronous). Ctrl/Meta-click keeps the X2 new-tab flow
  // (D8/ruling 4); no PROXY_PREVIEW_CTX at all ⇒ new-tab as well (§4.3).
  const frame = proxyPreview?.handle ?? null;
  if (frame !== null && frame.scope.value !== null && (ev === undefined || (!ev.ctrlKey && !ev.metaKey))) {
    clearNote();
    frame.open(href);
    return;
  }
  clearNote();
  void proxy.open(href).then(() => {
    const key = proxy.errorKey.value;
    const url = proxy.fallbackUrl.value;
    if (key === null && url === null) return;
    note.value = { href, key, url };
    noteTimer = setTimeout(clearNote, NOTE_MS);
  });
}
onBeforeUnmount(() => {
  clearNote();
  proxy.clear();
});

function onProxyKeydown(ev: KeyboardEvent, href: string): void {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    openProxy(href);
  }
}

type PSeg =
  | { kind: "text"; text: string }
  | { kind: "ref"; text: string; path: string }
  | { kind: "proxy"; text: string; href: string };
/** Path-ref segments (or one plain segment) with their text parts split on proxy URLs; `null` when
 * no URL matched at all (⇒ the legacy rendering, byte-identical). */
const proxySegments = computed<PSeg[] | null>(() => {
  if (!proxyActive.value || props.code === true) return null;
  const base: Segments = plain.value ? [{ kind: "text", text: props.text }] : renderedSegments.value;
  let found = false;
  const out: PSeg[] = [];
  for (const seg of base) {
    if (seg.kind !== "text") {
      out.push(seg as PSeg);
      continue;
    }
    for (const p of findProxyUrlRefs(seg.text)) {
      if (p.kind === "ref") {
        found = true;
        out.push({ kind: "proxy", text: p.text, href: p.href });
      } else out.push({ kind: "text", text: p.text });
    }
  }
  return found ? out : null;
});
/** Inline code that is exactly one proxyable URL (`` `http://127.0.0.1:3000` ``). §4.2 (r2
 * review #1): the value sent to the hub is the LP2-NORMALIZED href (`127.0.0.1:3000/ui` ⇒
 * `http://127.0.0.1:3000/ui`, port-less `http://127.0.0.1/` ⇒ `http://127.0.0.1:80/`) — the
 * same string every flow (dialog / new tab / legacy) POSTs as `{target}`; the template keeps
 * displaying the raw text. */
const codeProxyHref = computed(() =>
  props.code === true && proxyActive.value ? normalizeProxyHref(props.text) : null,
);

/** The §4.6 DOM-equivalence condition: any of these ⇒ render exactly like today. */
const plain = computed(
  () => props.noRefs === true || suspended?.value === true || ctx === null || scope.value === null,
);

/** 2026-10-07 修订: the probe controller — absent ⇒ legacy always-clickable rendering. */
const probe = computed(() => ctx?.handle.probe ?? null);

type Segments = ReturnType<typeof findPathRefs>;
const segments = computed<Segments | null>(() =>
  props.code === true || plain.value ? null : findPathRefs(props.text, scope.value),
);
const codeRef = computed(() => (props.code === true && !plain.value ? pathRefOfCode(props.text, scope.value) : null));

/** A candidate is clickable iff confirmed by the backend (or no probe pipeline exists). */
function clickable(path: string): boolean {
  const p = probe.value;
  return p === null ? true : p.stateOf(path) === "confirmed";
}

/** Candidates of this instance, in render order — submitted to the probe pipeline so the
 * composable can batch ONE request per tick. Empty whenever plain (streaming included —
 * §4.6 流式抑制 keeps probe traffic off half-typed messages too). */
const candidates = computed<string[]>(() => {
  const p = probe.value;
  if (p === null || plain.value) return [];
  const list: string[] = [];
  if (props.code === true) {
    const cr = codeRef.value;
    if (cr !== null) {
      list.push(cr.path);
      if (cr.alt !== undefined) list.push(cr.alt.path);
    }
    return list;
  }
  const segs = segments.value;
  if (segs !== null)
    for (const seg of segs)
      if (seg.kind === "ref") {
        list.push(seg.path);
        if (seg.alt !== undefined) list.push(seg.alt.path);
      }
  return list;
});

const renderedSegments = computed<Segments>(() => {
  const source: Segments =
    props.code === true ? (codeRef.value === null ? [] : [{ kind: "ref", ...codeRef.value }]) : (segments.value ?? []);
  return source.flatMap((seg): Segments => {
    if (seg.kind !== "ref" || clickable(seg.path) || seg.alt === undefined || !clickable(seg.alt.path)) return [seg];
    return [
      { kind: "ref", text: seg.alt.text, path: seg.alt.path },
      { kind: "text", text: seg.text.slice(seg.alt.text.length) },
    ];
  });
});

watch(
  candidates,
  (paths) => {
    if (paths.length > 0) probe.value?.ensure(paths);
  },
  { immediate: true },
);

function openPath(path: string): void {
  ctx?.handle.open({ path });
}

/** `role="button"` keyboard grammar: Enter/Space activate (Space default would scroll). */
function onRefKeydown(ev: KeyboardEvent, path: string): void {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    openPath(path);
  }
}
</script>

<template>
  <code
    v-if="code === true && codeRef !== null && clickable(codeRef.path)"
    class="md-code path-ref"
    role="button"
    tabindex="0"
    @click="openPath(codeRef.path)"
    @keydown="onRefKeydown($event, codeRef.path)"
    >{{ text }}</code
  >
  <code
    v-else-if="codeProxyHref !== null"
    class="md-code proxy-ref"
    role="button"
    tabindex="0"
    :title="t('proxy.refTitle')"
    @click="openProxy(codeProxyHref, $event)"
    @keydown="onProxyKeydown($event, codeProxyHref)"
    >{{ text }}</code
  >
  <code v-else-if="code === true" class="md-code"
    ><template v-for="(seg, i) in renderedSegments" :key="i"
      ><span
        v-if="seg.kind === 'ref' && clickable(seg.path)"
        class="path-ref"
        role="button"
        tabindex="0"
        @click="openPath(seg.path)"
        @keydown="onRefKeydown($event, seg.path)"
        >{{ seg.text }}</span
      ><template v-else>{{ seg.text }}</template></template
    ><template v-if="renderedSegments.length === 0">{{ text }}</template></code
  >
  <template v-else-if="proxySegments !== null">
    <template v-for="(seg, i) in proxySegments" :key="i">
      <span
        v-if="seg.kind === 'proxy'"
        class="proxy-ref"
        role="button"
        tabindex="0"
        :title="t('proxy.refTitle')"
        @click="openProxy(seg.href, $event)"
        @keydown="onProxyKeydown($event, seg.href)"
        >{{ seg.text }}</span
      >
      <span
        v-else-if="seg.kind === 'ref' && clickable(seg.path)"
        class="path-ref"
        role="button"
        tabindex="0"
        @click="openPath(seg.path)"
        @keydown="onRefKeydown($event, seg.path)"
        >{{ seg.text }}</span
      >
      <template v-else>{{ seg.text }}</template>
    </template>
  </template>
  <template v-else-if="plain || segments === null">{{ text }}</template>
  <template v-else>
    <template v-for="(seg, i) in renderedSegments" :key="i">
      <span
        v-if="seg.kind === 'ref' && clickable(seg.path)"
        class="path-ref"
        role="button"
        tabindex="0"
        @click="openPath(seg.path)"
        @keydown="onRefKeydown($event, seg.path)"
        >{{ seg.text }}</span
      >
      <template v-else>{{ seg.text }}</template>
    </template>
  </template>
  <span v-for="n in noteList" :key="'proxy-note'" class="proxy-ref-note" role="status"
    ><template v-if="n.key !== null"
      >{{ t(n.key) }}
      <!-- D9: a hub refusal always offers the original link as a native anchor (never an
           automatic navigation). -->
      <a :href="n.href" target="_blank" rel="noopener noreferrer">{{ t("proxy.preview.openOriginal") }} ↗</a></template
    ><template v-else-if="n.url !== null"
      >{{ t("proxy.blockedNote") }}
      <a :href="n.url" target="_blank" rel="noopener noreferrer">{{ t("proxy.blockedLink") }}</a></template
    ></span
  >
</template>
