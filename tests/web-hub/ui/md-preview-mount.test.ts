// @vitest-environment happy-dom
/**
 * J1 #5 (jank-20kb, md cold open) — MdPreviewBody: the RENDERED markdown body mounts its
 * leading blocks on the first frame and grows the rest in idle batches (append-only — the
 * final DOM is byte-identical to a plain `<MdBlock :nodes>`). Pins the staging itself, the
 * final-DOM equality, the ≤first-blocks fast path, and the PreviewText integration.
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import MdBlock from "../../../src/web-hub/ui/src/components/transcript/MdBlock.vue";
import MdPreviewBody, {
  MD_PREVIEW_BATCH_BLOCKS,
  MD_PREVIEW_FIRST_BLOCKS,
} from "../../../src/web-hub/ui/src/components/preview/MdPreviewBody.vue";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";
import { parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";
import type { MdNode } from "../../../src/web-hub/ui/src/components/transcript/markdown-types.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** A deterministic md with `n` top-level blocks (paragraphs + fences). */
function bigMd(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) parts.push("```ts\nconst v" + i + " = 1;\n```");
    else parts.push(`Paragraph ${i} with **bold** and a [link](/x).\n`);
  }
  return parts.join("\n\n");
}

const nodesOf = (text: string): readonly MdNode[] => parseMarkdown(text, { preview: true }) as readonly MdNode[];

/** Sweep macrotasks until `cond` (idle batches ride setTimeout/RIC — both timer-bound here). */
async function sweepUntil(cond: () => boolean, rounds = 400): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 0));
  }
  return cond();
}

describe("MdPreviewBody — progressive mount (J1 #5)", () => {
  it("exports the ruled staging constants", () => {
    expect(MD_PREVIEW_FIRST_BLOCKS).toBe(8);
    expect(MD_PREVIEW_BATCH_BLOCKS).toBeGreaterThan(0);
  });

  it("≤ first-blocks budget: everything mounts on the FIRST frame (no staging)", async () => {
    const text = bigMd(8);
    const w = mount(MdPreviewBody, { props: { nodes: nodesOf(text) } });
    expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(8); // complete immediately
    await new Promise((r) => setTimeout(r, 120));
    expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(8); // and stays
    w.unmount();
  });

  it("a big body mounts the LEADING blocks first, then completes in idle batches", async () => {
    const text = bigMd(60);
    const nodes = nodesOf(text);
    const w = mount(MdPreviewBody, { props: { nodes } });
    // first frame: exactly the leading budget
    expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(MD_PREVIEW_FIRST_BLOCKS);
    // final DOM: EVERY block, byte-identical to a plain MdBlock over the same nodes
    const done = await sweepUntil(() => w.element.querySelectorAll(".md-p, .codeblock").length === 60);
    expect(done).toBe(true);
    const reference = mount(MdBlock, { props: { nodes } });
    expect(w.element.textContent).toBe(reference.element.textContent);
    expect(w.element.innerHTML).toBe(reference.element.innerHTML); // final DOM: byte-identical
    reference.unmount();
    w.unmount();
  });

  it("append-only staging: mounted leading blocks are never re-removed mid-run", async () => {
    const text = bigMd(50);
    const w = mount(MdPreviewBody, { props: { nodes: nodesOf(text) } });
    const first = w.element.querySelector(".md-p");
    expect(first?.textContent).toContain("Paragraph 0");
    let monotone = true;
    let last = 0;
    for (let i = 0; i < 400; i++) {
      const n = w.element.querySelectorAll(".md-p, .codeblock").length;
      if (n < last) monotone = false;
      last = n;
      if (n >= 50) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(monotone).toBe(true); // never shrinks — batches only APPEND
    expect(last).toBe(50);
    w.unmount();
  });

  it("unmount mid-run stops the idle chain (no late growth, no errors)", async () => {
    const text = bigMd(80);
    const w = mount(MdPreviewBody, { props: { nodes: nodesOf(text) } });
    w.unmount(); // immediately — before any batch
    await new Promise((r) => setTimeout(r, 150));
    expect(document.querySelectorAll(".md-p").length).toBe(0);
  });
});

describe("PreviewText rendered-md integration (J1 #5)", () => {
  it("a big .md opens rendered with leading blocks, then completes", async () => {
    const text = bigMd(40);
    const w = mount(PreviewText, {
      props: { text, truncated: false, filename: "README.md", path: "/p/README.md" },
      attachTo: document.body,
    });
    expect(w.find(".preview-md").exists()).toBe(true);
    expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(MD_PREVIEW_FIRST_BLOCKS);
    await vi.waitFor(
      () => {
        expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(40);
      },
      { timeout: 4_000, interval: 10 },
    );
    // toggle to source and back: remounts the rendered view — completes again
    await w.findAll(".preview-toggle-btn")[1]!.trigger("click"); // 源码
    expect(w.find("pre.preview-text-body").exists()).toBe(true);
    await w.findAll(".preview-toggle-btn")[0]!.trigger("click"); // 渲染
    expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(MD_PREVIEW_FIRST_BLOCKS);
    await vi.waitFor(
      () => {
        expect(w.element.querySelectorAll(".md-p, .codeblock").length).toBe(40);
      },
      { timeout: 4_000, interval: 10 },
    );
    w.unmount();
  });
});
