/**
 * `@logic/markdown.js`'s `parseMarkdown`/`isSafeHref` parser-level tests (vue-plan.md v2.1
 * §3.1/§3.10/§4.1, §5.2 — P5b cleanup of the interrupted P5b `git mv`).
 *
 * The DOM-rendering half of the legacy test (`toDom`, built on the deleted `render/dom.js`'s
 * `el()`) is gone along with `toDom`/`renderMarkdown` themselves — the Vue UI renders the same
 * `MdNode[]` AST with `MarkdownView.vue`/`MdBlock.vue`/`MdInline.vue`, whose own
 * `markdown-view.test.ts` already ports this file's XSS corpus to a mounted-component assertion
 * (§4.1's disposition: "parse 部分保留；toDom 部分迁为 MarkdownView 组件测试"). This file keeps
 * only the parser-level assertions: the AST `parseMarkdown` produces, and `isSafeHref`'s
 * allow-list.
 */
import { describe, expect, it } from "vitest";
import { isSafeHref, parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";

describe("markdown whitelist (parser level)", () => {
  it("javascript:/data:/vbscript:/relative links do not produce a link node", () => {
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
    }
  });

  it("isSafeHref: only http(s) URLs pass", () => {
    expect(isSafeHref("https://example.com/a?b=1")).toBe(true);
    expect(isSafeHref("http://h/y")).toBe(true);
    expect(isSafeHref(" javascript:x")).toBe(false);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
  });

  it("http(s) links parse into link nodes carrying their href and text children", () => {
    const nodes = parseMarkdown("see [docs](https://example.com/a?b=1) and [x](http://h/y)");
    const links = JSON.parse(JSON.stringify(nodes)).flatMap(
      (n: { children?: unknown[] }) => n.children ?? [],
    ) as Array<{ type: string; href?: string; children?: Array<{ text?: string }> }>;
    const linkNodes = links.filter((n) => n.type === "link");
    expect(linkNodes.map((n) => n.href)).toEqual(["https://example.com/a?b=1", "http://h/y"]);
    expect(linkNodes[0]!.children?.[0]?.text).toBe("docs");
  });

  it("raw HTML in the source stays literal text nodes, never a distinct node type", () => {
    const md =
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> **<b>bold</b>**\n\n```\n<script>x</script>\n```';
    const nodes = parseMarkdown(md);
    const serialized = JSON.stringify(nodes);
    expect(serialized).toContain("<script>alert(1)</script>");
    expect(serialized).toContain('<img src=x onerror=\\"alert(1)\\">');
    // "bold" survives as a `strong` node, never as a literal `<b>` element/tag reference
    expect(serialized).not.toMatch(/"type":"b"/);
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
    expect(parseMarkdown("**open and `tick")[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", text: "**open and `tick" }],
    });
    const snakeCase = JSON.stringify(parseMarkdown("snake_case_name and 2 * 3 * 4"));
    expect(snakeCase).not.toContain('"type":"em"');
  });

  it("lists (ordered/unordered, continuation) and headings", () => {
    const nodes = parseMarkdown("# Title\n- a\n- b\n  more\n1. one\n2. two\n\npara");
    expect(nodes.map((n) => n.type)).toEqual(["heading", "list", "list", "paragraph"]);
    const list = parseMarkdown("- a\n- b\n  more")[0] as { items: Array<Array<{ text?: string }>> };
    expect(list.items.map((item) => item.map((n) => n.text).join(""))).toEqual(["a", "b\nmore"]);
    expect((parseMarkdown("1. x")[0] as { ordered: boolean }).ordered).toBe(true);
  });

  it("non-string input yields no nodes; CRLF normalized", () => {
    expect(parseMarkdown(undefined)).toEqual([]);
    expect(parseMarkdown({ x: 1 })).toEqual([]);
    expect(parseMarkdown("a\r\nb")).toEqual([{ type: "paragraph", children: [{ type: "text", text: "a\nb" }] }]);
  });

  it("deeply nested emphasis is bounded (no stack blowup)", () => {
    const md = "*".repeat(5000) + "x" + "*".repeat(5000);
    expect(() => parseMarkdown(md)).not.toThrow();
  });
});
