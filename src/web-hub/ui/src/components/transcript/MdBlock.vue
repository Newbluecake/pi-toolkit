<!--
  Recursive block-level renderer for a `parseMarkdown()` AST (ui-design.md §3.10/§13,
  vue-plan.md v2.1 §3.10/§5.2 — P4). Headings visually downgrade to h3–h6 (ui-design.md §12's
  "降级为 h3-h6 视觉" — a markdown `#` heading inside a chat message must never outrank the
  page's own `h1`/`h2` landmarks, §3.12). Fenced code blocks hand off to `CodeBlock.vue` (its
  own copy-button chrome); every other node type renders through plain text interpolation.
  `blocks` normalizes the AST into one flat, non-generic shape up front so the template itself
  never needs a TS type assertion (Vue template expressions support `as`, but keeping the cast
  out of the template is simpler to read and to type-check).
-->
<script setup lang="ts">
import { computed } from "vue";
import type { Inline, MdNode } from "./markdown-types.js";
import CodeBlock from "./CodeBlock.vue";
import MdInline from "./MdInline.vue";

const props = defineProps<{ readonly nodes: readonly MdNode[] }>();

function headingTag(level: number): string {
  return `h${Math.min(6, Math.max(3, level + 2))}`;
}

type BlockView =
  | { readonly kind: "code"; readonly lang: string; readonly text: string }
  | { readonly kind: "heading"; readonly tag: string; readonly children: readonly Inline[] }
  | { readonly kind: "listUl"; readonly items: ReadonlyArray<readonly Inline[]> }
  | { readonly kind: "listOl"; readonly items: ReadonlyArray<readonly Inline[]> }
  | { readonly kind: "paragraph"; readonly children: readonly Inline[] };

const blocks = computed<BlockView[]>(() =>
  props.nodes.map((n): BlockView => {
    switch (n.type) {
      case "code_block":
        return { kind: "code", lang: n.lang, text: n.text };
      case "heading":
        return { kind: "heading", tag: headingTag(n.level), children: n.children };
      case "list":
        return n.ordered ? { kind: "listOl", items: n.items } : { kind: "listUl", items: n.items };
      default:
        return { kind: "paragraph", children: n.children };
    }
  }),
);
</script>

<template>
  <template v-for="(b, i) in blocks" :key="i">
    <CodeBlock v-if="b.kind === 'code'" :lang="b.lang" :text="b.text" />
    <component v-else-if="b.kind === 'heading'" :is="b.tag" class="md-h"><MdInline :nodes="b.children" /></component>
    <ul v-else-if="b.kind === 'listUl'" class="md-list">
      <li v-for="(item, j) in b.items" :key="j"><MdInline :nodes="item" /></li>
    </ul>
    <ol v-else-if="b.kind === 'listOl'" class="md-list">
      <li v-for="(item, j) in b.items" :key="j"><MdInline :nodes="item" /></li>
    </ol>
    <p v-else class="md-p"><MdInline :nodes="b.children" /></p>
  </template>
</template>
