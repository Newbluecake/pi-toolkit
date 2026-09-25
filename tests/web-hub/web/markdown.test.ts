import { describe, expect, it } from "vitest";
import { isSafeHref, parseMarkdown, toDom } from "../../../src/web-hub/web/render/markdown.js";
import { allElements, byTag, fakeDocument, FakeNode } from "./fake-dom.js";

const dom = (md: string) => toDom(parseMarkdown(md), fakeDocument() as any) as unknown as FakeNode;

describe("markdown whitelist", () => {
  it("javascript: / data: / relative links degrade to literal text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>x</script>",
      "/api/logout",
      "vbscript:x",
    ]) {
      const md = `click [me](${href}) now`;
      const nodes = parseMarkdown(md);
      expect(JSON.stringify(nodes)).not.toContain('"link"');
      const root = dom(md);
      expect(byTag(root, "a")).toHaveLength(0);
      expect(root.textContent).toBe(md);
    }
  });

  it("http(s) links become <a> with rel noopener and a safe href", () => {
    const root = dom("see [docs](https://example.com/a?b=1) and [x](http://h/y)");
    const links = byTag(root, "a");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1", "http://h/y"]);
    expect(links[0]!.getAttribute("rel")).toContain("noopener");
    expect(links[0]!.textContent).toBe("docs");
    expect(isSafeHref("https://x")).toBe(true);
    expect(isSafeHref(" javascript:x")).toBe(false);
  });

  it("<script> and raw HTML stay text nodes (no element is ever created from source)", () => {
    const md =
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> **<b>bold</b>**\n\n```\n<script>x</script>\n```';
    const root = dom(md);
    const tags = new Set(allElements(root).map((e) => e.tagName));
    for (const bad of ["script", "img", "b", "iframe"]) expect(tags.has(bad)).toBe(false);
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    // only whitelisted tags are produced
    for (const t of tags)
      expect(["p", "pre", "code", "strong", "em", "a", "ul", "ol", "li", "h3", "h4", "h5", "h6"]).toContain(t);
  });

  it("fenced code: nested shorter fences stay inside a longer fence", () => {
    const md = "````md\n```js\nconsole.log(1)\n```\n````\nafter";
    const nodes = parseMarkdown(md);
    expect(nodes[0]).toEqual({ type: "code_block", lang: "md", text: "```js\nconsole.log(1)\n```" });
    expect(nodes[1]).toEqual({ type: "paragraph", children: [{ type: "text", text: "after" }] });
  });

  it("unclosed fenced code runs to the end of the text", () => {
    const nodes = parseMarkdown("intro\n```\nline1\n**not bold**");
    expect(nodes).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "intro" }] },
      { type: "code_block", lang: "", text: "line1\n**not bold**" },
    ]);
  });

  it("~~~ fences are not closed by ``` fences", () => {
    const nodes = parseMarkdown("~~~\na\n```\nb\n~~~");
    expect(nodes).toEqual([{ type: "code_block", lang: "", text: "a\n```\nb" }]);
  });

  it("inline code, bold, italic, nesting; unclosed markers are literal", () => {
    expect(parseMarkdown("a `x<y>` **b _c_** *d* e")[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", text: "a " },
        { type: "code", text: "x<y>" },
        { type: "text", text: " " },
        {
          type: "strong",
          children: [
            { type: "text", text: "b " },
            { type: "em", children: [{ type: "text", text: "c" }] },
          ],
        },
        { type: "text", text: " " },
        { type: "em", children: [{ type: "text", text: "d" }] },
        { type: "text", text: " e" },
      ],
    });
    expect(dom("**open and `tick").textContent).toBe("**open and `tick");
    expect(byTag(dom("snake_case_name and 2 * 3 * 4"), "em")).toHaveLength(0);
  });

  it("lists (ordered/unordered, continuation) and headings", () => {
    const nodes = parseMarkdown("# Title\n- a\n- b\n  more\n1. one\n2. two\n\npara");
    expect(nodes.map((n) => n.type)).toEqual(["heading", "list", "list", "paragraph"]);
    const root = dom("- a\n- b\n  more");
    const lis = byTag(root, "li");
    expect(lis.map((l) => l.textContent)).toEqual(["a", "b\nmore"]);
    expect(byTag(dom("1. x"), "ol")).toHaveLength(1);
  });

  it("non-string input yields no nodes; CRLF normalized", () => {
    expect(parseMarkdown(undefined)).toEqual([]);
    expect(parseMarkdown({ x: 1 })).toEqual([]);
    expect(parseMarkdown("a\r\nb")).toEqual([{ type: "paragraph", children: [{ type: "text", text: "a\nb" }] }]);
  });

  it("deeply nested emphasis is bounded (no stack blowup)", () => {
    const md = "*".repeat(5000) + "x" + "*".repeat(5000);
    expect(() => dom(md)).not.toThrow();
  });
});
