<!--
  Recursive inline-node renderer for a `parseMarkdown()` AST (ui-design.md §3.10/§13,
  vue-plan.md v2.1 §3.10/§5.2 — P4). Every branch renders through Vue's own template
  interpolation/element creation — no `v-html`, no raw HTML ever touches the DOM. `link` only
  renders an `<a>` because `parseMarkdown` already rejected any non-`isSafeHref` target at parse
  time (the inline text form `[text](javascript:…)` survives *as literal text*, produced by the
  parser itself — this component never re-checks `isSafeHref`).
-->
<script setup lang="ts">
import type { Inline } from "./markdown-types.js";

defineProps<{ readonly nodes: readonly Inline[] }>();
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <template v-if="n.type === 'text'">{{ n.text }}</template>
    <code v-else-if="n.type === 'code'" class="md-code">{{ n.text }}</code>
    <strong v-else-if="n.type === 'strong'"><MdInline :nodes="n.children" /></strong>
    <em v-else-if="n.type === 'em'"><MdInline :nodes="n.children" /></em>
    <a v-else-if="n.type === 'link'" :href="n.href" rel="noopener noreferrer nofollow" target="_blank"
      ><MdInline :nodes="n.children"
    /></a>
  </template>
</template>
