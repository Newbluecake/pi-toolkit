<!--
  Recursive block-level renderer for a `parseMarkdown()` AST (ui-design.md §3.10/§13,
  vue-plan.md v2.1 §3.10/§5.2 — P4; extended by the markdown-whitelist-extension package with
  GFM tables, blockquotes and task list items). Headings visually downgrade to h3–h6
  (ui-design.md §12's "降级为 h3-h6 视觉" — a markdown `#` heading inside a chat message must
  never outrank the page's own `h1`/`h2` landmarks, §3.12). Fenced code blocks hand off to
  `CodeBlock.vue` (its own copy-button chrome); every other node type renders through plain
  text interpolation. `blocks` normalizes the AST into one flat, non-generic shape up front so
  the template itself never needs a TS type assertion (Vue template expressions support `as`,
  but keeping the cast out of the template is simpler to read and to type-check).
  Tables render inside a horizontally scrollable wrapper (`tabindex="0"` so the scroll region
  is keyboard-reachable, same axe rule as `CodeBlock.vue`'s `<pre>`); blockquotes recurse into
  this same component (Vue resolves the self-reference by filename); task items render as a
  read-only `role="checkbox"` span — never a real (interactive) `<input>`.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { Inline, MdNode, TableAlign } from "./markdown-types.js";
import CodeBlock from "./CodeBlock.vue";
import MdInline from "./MdInline.vue";

const props = defineProps<{ readonly nodes: readonly MdNode[] }>();

function headingTag(level: number): string {
  return `h${Math.min(6, Math.max(3, level + 2))}`;
}

type BlockView =
  | { readonly kind: "code"; readonly lang: string; readonly text: string }
  | { readonly kind: "heading"; readonly tag: string; readonly children: readonly Inline[] }
  | {
      readonly kind: "listUl";
      readonly items: ReadonlyArray<readonly Inline[]>;
      readonly checked: ReadonlyArray<boolean | null> | undefined;
    }
  | {
      readonly kind: "listOl";
      readonly items: ReadonlyArray<readonly Inline[]>;
      readonly checked: ReadonlyArray<boolean | null> | undefined;
    }
  | { readonly kind: "paragraph"; readonly children: readonly Inline[] }
  | { readonly kind: "quote"; readonly children: readonly MdNode[] }
  | {
      readonly kind: "table";
      readonly align: readonly TableAlign[];
      readonly header: ReadonlyArray<readonly Inline[]>;
      readonly rows: ReadonlyArray<ReadonlyArray<readonly Inline[]>>;
    };

const blocks = computed<BlockView[]>(() =>
  props.nodes.map((n): BlockView => {
    switch (n.type) {
      case "code_block":
        return { kind: "code", lang: n.lang, text: n.text };
      case "heading":
        return { kind: "heading", tag: headingTag(n.level), children: n.children };
      case "list":
        return n.ordered
          ? { kind: "listOl", items: n.items, checked: n.checked }
          : { kind: "listUl", items: n.items, checked: n.checked };
      case "quote":
        return { kind: "quote", children: n.children };
      case "table":
        return { kind: "table", align: n.align, header: n.header, rows: n.rows };
      default:
        return { kind: "paragraph", children: n.children };
    }
  }),
);

function alignClass(align: TableAlign | undefined): string | undefined {
  return align === "center" ? "md-tc" : align === "right" ? "md-tr" : undefined;
}

function taskChecked(b: BlockView, j: number): boolean | null {
  if ((b.kind === "listUl" || b.kind === "listOl") && b.checked) {
    const v = b.checked[j];
    return typeof v === "boolean" ? v : null;
  }
  return null;
}
</script>

<template>
  <template v-for="(b, i) in blocks" :key="i">
    <CodeBlock v-if="b.kind === 'code'" :lang="b.lang" :text="b.text" />
    <component v-else-if="b.kind === 'heading'" :is="b.tag" class="md-h"><MdInline :nodes="b.children" /></component>
    <ul v-else-if="b.kind === 'listUl'" class="md-list">
      <li v-for="(item, j) in b.items" :key="j" :class="{ 'md-task': taskChecked(b, j) !== null }">
        <span
          v-if="taskChecked(b, j) !== null"
          class="md-task-check"
          role="checkbox"
          :aria-checked="taskChecked(b, j) === true"
          aria-disabled="true"
          >{{ taskChecked(b, j) ? "☑" : "☐" }}</span
        ><MdInline :nodes="item" />
      </li>
    </ul>
    <ol v-else-if="b.kind === 'listOl'" class="md-list">
      <li v-for="(item, j) in b.items" :key="j" :class="{ 'md-task': taskChecked(b, j) !== null }">
        <span
          v-if="taskChecked(b, j) !== null"
          class="md-task-check"
          role="checkbox"
          :aria-checked="taskChecked(b, j) === true"
          aria-disabled="true"
          >{{ taskChecked(b, j) ? "☑" : "☐" }}</span
        ><MdInline :nodes="item" />
      </li>
    </ol>
    <blockquote v-else-if="b.kind === 'quote'" class="md-quote"><MdBlock :nodes="b.children" /></blockquote>
    <div v-else-if="b.kind === 'table'" class="md-table-wrap" tabindex="0">
      <table class="md-table">
        <thead>
          <tr>
            <th v-for="(cell, ci) in b.header" :key="ci" scope="col" :class="alignClass(b.align[ci])">
              <MdInline :nodes="cell" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in b.rows" :key="ri">
            <td v-for="(cell, ci) in row" :key="ci" :class="alignClass(b.align[ci])"><MdInline :nodes="cell" /></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="md-p"><MdInline :nodes="b.children" /></p>
  </template>
</template>
