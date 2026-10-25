<!--
  VirtualBlock.vue — one 32-line block of the virtual-scroll source body (preview-perf P2,
  plan r3 §4.2). The DUMB half of the renderer: `DisplayLine[]` in, CodeLines-grammar DOM
  out. All windowing / freezing / geometry lives in VirtualCode.vue.

  DOM contract (§4.2, byte-shared with CodeLines' syntax, three deliberate differences):
  - root is `span.pv-lines.pv-vblock` with `counter-reset: pvline <start-1>` (the gutter
    number is a CSS counter — NEVER a DOM node, selection/copy stay pure body text) and
    `data-start` (tests + diagnostics only);
  - the root does NOT set `--pvline-w` — the gutter width is unified on the spacer by
    VirtualCode (§4.4); it does carry its own inline `top` (blockIndex × 32 × rowH, §4.3);
  - a clipped line gets an EMPTY `span.pv-vclip` (data-clip / data-clip-label) between the
    parts and the terminator; the `…(+N)` marker is ::before generated content — never DOM
    text (r3 §R2 #1: the "\n" must stay the line element's LAST child so the browser
    swallows it and the line keeps exactly one line box).

  Render function (not a template) on purpose — same as CodeLines: a template's per-part
  v-if/v-else compiles to anchor comments that become empty text nodes under
  `comments:false`, ~3 dead nodes per token part on token-heavy bodies.

  Perf contract (§4.5): all four props are primitives or STABLE references. While a native
  selection is active VirtualCode passes the exact same `lines` array object (frozen),
  so Vue's shouldUpdateComponent shallow-compare skips this subtree entirely and no text
  node is ever replaced — the native selection's Range endpoints stay valid.
-->
<script lang="ts">
import { computed, defineComponent, h, type VNodeChild } from "vue";
import type { DisplayLine } from "@logic/previewVirtualTypes.js";

export default defineComponent({
  name: "VirtualBlock",
  props: {
    /** Display form of lines [start, start + 32) — WITHOUT terminators (DisplayLine.eol). */
    lines: { type: Array as () => readonly DisplayLine[], required: true },
    /** 1-based number of the block's first line (counter-reset = start − 1). */
    start: { type: Number, required: true },
    /** Absolute top in px = blockIndex × 32 × rowH (inline style on the root). */
    topPx: { type: Number, required: true },
    /** Builds the clip marker's alt text ("本行超长，已截断 N 个字符"). */
    clipLabel: { type: Function as unknown as () => (n: number) => string, required: true },
  },
  setup(props) {
    const resetValue = computed(() => props.start - 1);
    return (): VNodeChild =>
      h(
        "span",
        {
          class: ["pv-lines", "pv-vblock"],
          style: { counterReset: `pvline ${resetValue.value}`, top: `${props.topPx}px` },
          "data-start": String(props.start),
        },
        props.lines.map((line) => {
          const children: VNodeChild[] = [];
          for (const p of line.parts) {
            // degenerate empty part: no dead text node (verbatim otherwise)
            if (p.text === "") continue;
            children.push(p.cls === "" ? p.text : h("span", { class: p.cls }, p.text));
          }
          if (line.clipped > 0) {
            // EMPTY span — the marker is ::before generated content (§4.2), placed BEFORE
            // the terminator so the "\n" stays block-final.
            children.push(
              h("span", {
                class: "pv-vclip",
                "data-clip": String(line.clipped),
                "data-clip-label": props.clipLabel(line.clipped),
              }),
            );
          }
          if (line.eol === "\n") children.push("\n");
          return h("span", { class: "pv-line" }, children);
        }),
      );
  },
});
</script>
