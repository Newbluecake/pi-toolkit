/**
 * `@logic/markdown.js`'s PREVIEW mode (`parseMarkdown(text, { preview: true })` — the
 * md-preview-html plan, user ruling 2026-10-20): standard `![alt](src)` images and the safe
 * HTML subset (`<p>/<div align>` block wrappers, inline `<img>`/`<br>`/`<sub>`/`<sup>`/
 * `<b>`/`<strong>`/`<i>`/`<em>`/`<code>`/`<a href>`). Everything outside the whitelist —
 * other tags, other attributes, malformed/unclosed constructs — stays literal text, exactly
 * as without the option (whose output the differential fixtures pin byte-for-byte).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMarkdown, scanMarkdownTail } from "../../../src/web-hub/ui/src/logic/markdown.js";
import { countMdNodes } from "../../../src/web-hub/ui/src/logic/preview.js";

const PREVIEW = { preview: true } as const;

/** Every inline node of the first block (paragraph / html_block). */
const inl = (md: string, opts?: typeof PREVIEW) => (parseMarkdown(md, opts)[0] as { children: any[] }).children;
const types = (nodes: any[]): string[] => JSON.stringify(nodes).match(/"type":"(\w+)"/g) ?? [];

describe("parseMarkdown preview mode — option off stays literal", () => {
  it("![x](y) and <img>/<p align> produce NO image/html_block nodes without the option", () => {
    const md = '![x](a.png)\n\n<p align="center">\n<img src="a.png" width="100%">\n<br>\n</p>';
    const off = parseMarkdown(md);
    const json = JSON.stringify(off);
    expect(json).not.toContain('"image"');
    expect(json).not.toContain('"html_block"');
    expect(json).not.toContain('"br"');
    // no image node without the option — the `![x](a.png)` link part keeps its normal
    // pathlink meaning (exactly today's behavior), and raw HTML survives as literal text
    expect(json).toContain('"!"');
    expect(json).toContain("<img src=");
    // … and the option flips exactly those constructs on
    const on = parseMarkdown(md, PREVIEW);
    expect(JSON.stringify(on)).toContain('"image"');
    expect(JSON.stringify(on)).toContain('"html_block"');
  });
});

describe("parseMarkdown preview mode — standard images", () => {
  it("![alt](src) → image node", () => {
    expect(inl("![shot](docs/x.png)", PREVIEW)[0]).toEqual({ type: "image", src: "docs/x.png", alt: "shot" });
  });
  it('![alt](src "title") carries the title', () => {
    expect(inl('![s](docs/x.png "cap")', PREVIEW)[0]).toEqual({
      type: "image",
      src: "docs/x.png",
      alt: "s",
      title: "cap",
    });
  });
  it("external http(s) srcs parse as image nodes (the COMPONENT refuses to fetch them)", () => {
    expect(inl("![b](https://img.shields.io/badge/x.svg)", PREVIEW)[0]).toMatchObject({
      type: "image",
      src: "https://img.shields.io/badge/x.svg",
    });
  });
});

describe("parseMarkdown preview mode — inline HTML whitelist", () => {
  it("<br>, <br/>, <br /> → br node", () => {
    for (const raw of ["<br>", "<br/>", "<br />"]) {
      expect(inl(`a${raw}b`, PREVIEW)[1]).toEqual({ type: "br" });
    }
  });
  it("<sub>/<sup> → sub/sup nodes with parsed children", () => {
    expect(inl("<sub>cap **x**</sub>", PREVIEW)[0]).toEqual({
      type: "sub",
      children: [
        { type: "text", text: "cap " },
        { type: "strong", children: [{ type: "text", text: "x" }] },
      ],
    });
    expect(inl("<sup>2</sup>", PREVIEW)[0]).toEqual({ type: "sup", children: [{ type: "text", text: "2" }] });
  });
  it("<b>/<strong> → strong, <i>/<em> → em, <code> → code", () => {
    expect(inl("<b>x</b>", PREVIEW)[0]).toMatchObject({ type: "strong" });
    expect(inl("<strong>x</strong>", PREVIEW)[0]).toMatchObject({ type: "strong" });
    expect(inl("<i>x</i>", PREVIEW)[0]).toMatchObject({ type: "em" });
    expect(inl("<em>x</em>", PREVIEW)[0]).toMatchObject({ type: "em" });
    expect(inl("<code>a<b</code>", PREVIEW)[0]).toEqual({ type: "code", text: "a<b" });
  });
  it("<a href>: http(s) → link, path → pathlink, other schemes / extra attrs → literal", () => {
    expect(inl('<a href="https://example.com/x">t</a>', PREVIEW)[0]).toMatchObject({
      type: "link",
      href: "https://example.com/x",
    });
    expect(inl('<a href="docs/x.md">t</a>', PREVIEW)[0]).toMatchObject({ type: "pathlink", target: "docs/x.md" });
    for (const md of [
      '<a href="javascript:alert(1)">t</a>',
      '<a href="data:text/html,x">t</a>',
      '<a class="c" href="https://example.com">t</a>',
      '<a href="https://example.com" target="_blank">t</a>',
    ]) {
      // literal — byte-identical to the no-option parse (an autolinkable URL inside the
      // literal text still autolinks, exactly as today)
      expect(parseMarkdown(md, PREVIEW), md).toEqual(parseMarkdown(md));
    }
  });
  it("<img> parses src/alt/width/height; px and % dims clamp into sane bounds", () => {
    expect(inl('<img src="a.png" alt="s" width="100%">', PREVIEW)[0]).toEqual({
      type: "image",
      src: "a.png",
      alt: "s",
      width: { n: 100, unit: "%" },
    });
    expect(inl('<img src="a.png" height="320">', PREVIEW)[0]).toMatchObject({ height: { n: 320, unit: "px" } });
    // clamps: px → [1, 2000], % → [1, 100]
    expect(inl('<img src="a.png" width="5000">', PREVIEW)[0]).toMatchObject({ width: { n: 2000, unit: "px" } });
    expect(inl('<img src="a.png" width="0">', PREVIEW)[0]).toMatchObject({ width: { n: 1, unit: "px" } });
    expect(inl('<img src="a.png" width="150%">', PREVIEW)[0]).toMatchObject({ width: { n: 100, unit: "%" } });
    // a malformed dimension is DROPPED, the image still parses
    const n = inl('<img src="a.png" width="10em">', PREVIEW)[0];
    expect(n.type).toBe("image");
    expect(n.width).toBeUndefined();
  });
  it("self-closing <img … /> parses; HTML entities in attributes decode", () => {
    expect(inl('<img src="a.png" alt="x" />', PREVIEW)[0]).toMatchObject({ type: "image", src: "a.png" });
    expect(inl('<img src="a.png?x=1&amp;y=2" alt="a &lt;b&gt; &quot;c&quot; &#39;d&#39;">', PREVIEW)[0]).toEqual({
      type: "image",
      src: "a.png?x=1&y=2",
      alt: "a <b> \"c\" 'd'",
    });
  });
  it("non-whitelisted attributes (style/class/on*/srcset) keep the WHOLE tag literal", () => {
    for (const md of [
      '<img src="a.png" onerror="alert(1)">',
      '<img src="a.png" style="width:100%">',
      '<img src="a.png" class="hero">',
      '<img src="a.png" srcset="a2.png 2x">',
      '<img src="a.png" loading="lazy">',
      "<img src=a.png>", // missing alt is fine, but unquoted src IS allowed — see next case
    ]) {
      const n = inl(md, PREVIEW);
      if (md === "<img src=a.png>") {
        expect(n[0]).toMatchObject({ type: "image", src: "a.png" });
      } else {
        expect(n, md).toEqual([{ type: "text", text: md }]);
      }
    }
    // a <script>/<iframe>/<div> inline stays literal too
    expect(JSON.stringify(inl("<script>alert(1)</script>", PREVIEW))).not.toContain('"code"');
    expect(inl("<script>alert(1)</script>", PREVIEW)[0]).toEqual({
      type: "text",
      text: "<script>alert(1)</script>",
    });
  });
  it("unclosed or empty paired tags stay literal", () => {
    expect(inl("<sub>never closed", PREVIEW)[0]).toEqual({ type: "text", text: "<sub>never closed" });
    expect(inl("<b></b>", PREVIEW)[0]).toEqual({ type: "text", text: "<b></b>" });
  });
  it("nesting beyond MAX_DEPTH stays literal (depth bound)", () => {
    const md = `${"<sub>".repeat(8)}x${"</sub>".repeat(8)}`;
    const json = JSON.stringify(inl(md, PREVIEW));
    // the outer levels parse; past the depth cap the tag is literal text
    expect(json).toContain("<sub>");
    expect((json.match(/"type":"sub"/g) ?? []).length).toBeLessThan(8);
  });
});

describe("parseMarkdown preview mode — <p>/<div align> block wrappers", () => {
  it("multi-line form (opening tag line, inner lines, closing tag line)", () => {
    const md = '<p align="center">\n  <img src="a.png" width="100%">\n  <br>\n  <sub>cap</sub>\n</p>';
    const nodes = parseMarkdown(md, PREVIEW);
    expect(nodes).toHaveLength(1);
    const b = nodes[0] as any;
    expect(b.type).toBe("html_block");
    expect(b.align).toBe("center");
    expect(b.children.map((c: any) => c.type)).toEqual(["text", "image", "text", "br", "text", "sub"]);
  });
  it("single-line form and <div> / left / right / no-align variants", () => {
    expect(parseMarkdown('<p align="right">hi <b>x</b></p>', PREVIEW)[0] as any).toMatchObject({
      type: "html_block",
      align: "right",
    });
    expect((parseMarkdown('<div align="left">x</div>', PREVIEW)[0] as any).align).toBe("left");
    expect(parseMarkdown("<p>plain</p>", PREVIEW)[0] as any).toMatchObject({ type: "html_block", align: "" });
  });
  it("invalid align / extra attributes / unclosed ⇒ literal paragraph text", () => {
    for (const md of [
      '<p align="middle">x</p>',
      '<p class="c">x</p>',
      '<p align="center" style="color:red">x</p>',
      '<p align="center">\nnever closed\n\nstill open',
    ]) {
      const json = JSON.stringify(parseMarkdown(md, PREVIEW));
      expect(json, md).not.toContain('"html_block"');
    }
  });
  it("a block open whose close lies beyond the 100-line bound stays literal", () => {
    const md = `<p align="center">\n${"filler\n".repeat(101)}</p>`;
    expect(JSON.stringify(parseMarkdown(md, PREVIEW))).not.toContain('"html_block"');
  });
  it("the new nodes count toward the AST node budget (PREVIEW_MD_NODE_MAX)", () => {
    const md = '<p align="center">\n<img src="a.png">\n<br>\n</p>';
    const off = countMdNodes(parseMarkdown(md)); // 1 paragraph + 1 text node
    const on = countMdNodes(parseMarkdown(md, PREVIEW)); // block + image + br + text nodes
    expect(off).toBe(2);
    expect(on).toBeGreaterThan(off);
  });
});

describe("parseMarkdown preview mode — README.md's actual top section", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
  const topEnd = readme.indexOf("\n## ");
  const top = readme.slice(0, topEnd);

  it("parses the hero + screenshot blocks into the expected tree", () => {
    const nodes = parseMarkdown(top, PREVIEW) as any[];
    expect(nodes[0]).toMatchObject({ type: "heading", level: 1 });
    const blocks = nodes.filter((n) => n.type === "html_block");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    // hero: centered, one 100%-width image, <br>, muted <sub> caption
    const hero = blocks[0];
    expect(hero.align).toBe("center");
    const heroImgs = hero.children.filter((c: any) => c.type === "image");
    expect(heroImgs).toHaveLength(1);
    expect(heroImgs[0]).toMatchObject({ src: "docs/images/hero-web-desktop.png", width: { n: 100, unit: "%" } });
    expect(hero.children.some((c: any) => c.type === "br")).toBe(true);
    const heroSub = hero.children.find((c: any) => c.type === "sub");
    expect(heroSub).toBeDefined();
    expect(JSON.stringify(heroSub.children)).toContain("Web UI");
    // screenshots: four images side by side at height 320px + caption
    const shots = blocks[1];
    const shotImgs = shots.children.filter((c: any) => c.type === "image");
    expect(shotImgs).toHaveLength(4);
    for (const img of shotImgs) expect(img.height).toEqual({ n: 320, unit: "px" });
    expect(shots.children.some((c: any) => c.type === "sub")).toBe(true);
  });

  it("the same section without the option is 100% literal (no image/html_block nodes)", () => {
    const json = JSON.stringify(parseMarkdown(top));
    expect(json).not.toContain('"image"');
    expect(json).not.toContain('"html_block"');
    expect(json).toContain("<p align=");
  });
});

describe("scanMarkdownTail preview mode", () => {
  it("never cuts inside an html block wrapper (segment≡whole invariant keeps holding)", () => {
    // the ONLY blank lines sit inside the wrapper: default mode cuts there, preview must not
    const text = '<p align="center">\n<img src="a.png">\n\n</p>\n';
    expect(scanMarkdownTail(text).cut).toBeGreaterThan(-1); // legacy: the inner blank is a cut
    const scan = scanMarkdownTail(text, PREVIEW);
    expect(scan.cut).toBe(-1);
  });
  it("cut segments concatenate back to the whole-doc preview parse", () => {
    const text = 'intro\n\n<p align="center">\n<img src="a.png">\n\n</p>\n\nafter ![x](b.png)\n';
    const scan = scanMarkdownTail(text, PREVIEW);
    expect(scan.cut).toBeGreaterThan(-1);
    const whole = parseMarkdown(text, PREVIEW);
    const joined = [
      ...parseMarkdown(text.slice(0, scan.cut), PREVIEW),
      ...parseMarkdown(text.slice(scan.cut), PREVIEW),
    ];
    expect(joined).toEqual(whole);
  });
});
