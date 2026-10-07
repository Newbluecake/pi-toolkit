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
import { computed, inject, watch } from "vue";
import { findPathRefs, pathRefOfCode } from "@logic/preview.js";
import { PATH_REFERENCES_SUSPENDED, PREVIEW_CTX } from "./previewContext.js";

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
    if (cr !== null) list.push(cr.path);
    return list;
  }
  const segs = segments.value;
  if (segs !== null) for (const seg of segs) if (seg.kind === "ref") list.push(seg.path);
  return list;
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
  <code v-else-if="code === true" class="md-code">{{ text }}</code>
  <template v-else-if="plain || segments === null">{{ text }}</template>
  <template v-else>
    <template v-for="(seg, i) in segments" :key="i">
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
</template>
