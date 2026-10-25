<!--
  CodeLines.vue — the numbered per-line source renderer (preview line-numbers package,
  2026-10-23). The ONE place "render by lines" lives (主会话约束 ①: 之后换虚拟列表只动这里):
  a dumb renderer in, DOM out — input is the line list (`@logic/previewLines.ts`'s
  `CodeLine[]`, each line's parts INCLUDING the line's own "\n" terminator) plus the first
  line's number and an optional continuation flag.

  DOM/perf contract (约束 ②):
  - ONE block element per line (`.pv-line`); the number is a CSS counter rendered by the
    line's `::before` — NEVER a DOM node. Selection and copy therefore stay pure body text,
    and the per-line DOM cost is a single element (plus the token spans highlighting adds).
  - Render function (not a template) on purpose: a template's per-part v-if/v-else compiles
    to anchor COMMENT nodes, which become EMPTY TEXT nodes under the build's `comments:false`
    — ~3 dead nodes per token part, measured 55k extra text nodes on a 3000-line file.
  - The gutter number sits on the line's FIRST visual line (absolutely positioned at the
    line box's top-left); soft-wrapped continuation lines align with the text column via
    the line's `padding-left` (`--pvline-w` + gap), no extra wrapper node.
  - `counterReset` + `--pvline-w` ride a runtime style OBJECT (CSSOM — the §7.1 CSP rule,
    same as PreviewHost's geometry vars, never a static style attribute).
  - Root is a `<span>` (display:block via CSS) so the component stays phrasing-content
    valid inside the preview's `<pre>` body; in stream mode PreviewText adds the legacy
    `preview-seg` class to this root (attrs fall through).

  `continuation` (chunked stream force cut, §4.3.4): the first line is the tail of the
  PREVIOUS segment's unfinished logical line — it renders without a number and without
  consuming one (`counter-increment: none`), so numbering survives mid-line segment cuts.
-->
<script lang="ts">
import { computed, defineComponent, h, type VNodeChild } from "vue";
import { lineNumberDigits, type CodeLine } from "@logic/previewLines.js";

export default defineComponent({
  name: "CodeLines",
  props: {
    lines: { type: Array as () => readonly CodeLine[], required: true },
    /** Number of the first NUMBERED line (1-based; with `continuation`, of the first line
     *  AFTER the unnumbered continuation head). */
    startLine: { type: Number, default: 1 },
    /** The first line continues the previous segment's unfinished logical line. */
    continuation: { type: Boolean, default: false },
  },
  setup(props) {
    /** Decimal gutter width for the largest number this block can show (min 2 — helper). */
    const digits = computed(() =>
      lineNumberDigits(props.startLine + Math.max(0, props.lines.length - 1) - (props.continuation ? 1 : 0)),
    );
    /** The counter sits at startLine-1 so the first increment lands on startLine; a
     *  continuation head never increments, so the reset shifts up by one to compensate. */
    const resetValue = computed(() => props.startLine - 1 + (props.continuation ? 1 : 0));
    return (): VNodeChild =>
      h(
        "span",
        {
          class: "pv-lines",
          style: { counterReset: `pvline ${resetValue.value}`, "--pvline-w": `${digits.value}ch` },
        },
        props.lines.map((line, i) =>
          h(
            "span",
            { class: ["pv-line", props.continuation && i === 0 ? "pv-line-cont" : undefined] },
            line.map((p) => (p.cls === "" ? p.text : h("span", { class: p.cls }, p.text))),
          ),
        ),
      );
  },
});
</script>
