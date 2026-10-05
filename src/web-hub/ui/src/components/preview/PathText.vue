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
-->
<script setup lang="ts">
import { computed, inject } from "vue";
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

type Segments = ReturnType<typeof findPathRefs>;
const segments = computed<Segments | null>(() =>
  props.code === true || plain.value ? null : findPathRefs(props.text, scope.value),
);
const codeRef = computed(() => (props.code === true && !plain.value ? pathRefOfCode(props.text, scope.value) : null));

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
    v-if="code === true && codeRef !== null"
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
        v-if="seg.kind === 'ref'"
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
