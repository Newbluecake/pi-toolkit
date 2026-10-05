<!--
  Recursive inline-node renderer for a `parseMarkdown()` AST (ui-design.md §3.10/§13,
  vue-plan.md v2.1 §3.10/§5.2 — P4). Every branch renders through Vue's own template
  interpolation/element creation — no `v-html`, no raw HTML ever touches the DOM. `link` only
  renders an `<a>` because `parseMarkdown` already rejected any non-`isSafeHref` target at parse
  time (the inline text form `[text](javascript:…)` survives *as literal text*, produced by the
  parser itself — this component never re-checks `isSafeHref`).

  PV6 (web-hub-preview plan v3 §4.6): `text` nodes render through `PathText` (path-ref scan)
  and `code` nodes through `PathText`'s code mode (`code.md-code[.path-ref]` — the exact same
  element when nothing matches, so every no-preview scenario stays DOM-identical). Inside a
  `link` the anchor itself is the interactive element, so its children render with `noRefs`
  (链接文本中不出现 `.path-ref` — PV6 验收); the flag also propagates through strong/em/del.
-->
<script setup lang="ts">
import PathText from "../preview/PathText.vue";
import type { Inline } from "./markdown-types.js";

defineProps<{
  readonly nodes: readonly Inline[];
  /** Force plain rendering for this subtree (link text — the anchor owns the interaction). */
  readonly noRefs?: boolean | undefined;
}>();
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <PathText v-if="n.type === 'text'" :text="n.text" :no-refs="noRefs" />
    <PathText v-else-if="n.type === 'code'" :text="n.text" code :no-refs="noRefs" />
    <strong v-else-if="n.type === 'strong'"><MdInline :nodes="n.children" :no-refs="noRefs" /></strong>
    <em v-else-if="n.type === 'em'"><MdInline :nodes="n.children" :no-refs="noRefs" /></em>
    <del v-else-if="n.type === 'del'"><MdInline :nodes="n.children" :no-refs="noRefs" /></del>
    <a v-else-if="n.type === 'link'" :href="n.href" rel="noopener noreferrer nofollow" target="_blank"
      ><MdInline :nodes="n.children" :no-refs="true"
    /></a>
  </template>
</template>
