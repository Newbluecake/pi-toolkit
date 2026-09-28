<!--
  Safe markdown rendering (ui-design.md §3.10/§13, vue-plan.md v2.1 §3.10/§5.2 — P4): parses via
  the already-tested `@logic/render/markdown.js`'s `parseMarkdown()` (an allow-listed subset —
  paragraphs/headings/lists/code/bold/italic/http(s) links only) and hands the AST to
  `MdBlock.vue`, which renders it through ordinary Vue interpolation/elements — `v-html` never
  appears anywhere in this tree (enforced repo-wide by `tests/web-hub/ui/source-scan.test.ts`).
  `parseMarkdown` re-runs on every `text` change, which is deliberately cheap: `Transcript.vue`
  only re-renders the currently-streaming message's tail on each delta (plan §3.6), not the
  whole history.
-->
<script setup lang="ts">
import { computed } from "vue";
import { parseMarkdown } from "@logic/markdown.js";
import type { MarkdownViewProps } from "../../contracts.js";
import type { MdNode } from "./markdown-types.js";
import MdBlock from "./MdBlock.vue";

const props = defineProps<MarkdownViewProps>();
const nodes = computed<readonly MdNode[]>(() => parseMarkdown(props.text) as readonly MdNode[]);
</script>

<template>
  <div class="md"><MdBlock :nodes="nodes" /></div>
</template>
