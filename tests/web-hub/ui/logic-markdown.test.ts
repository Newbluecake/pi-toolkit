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

describe("GFM pipe tables (parser level)", () => {
  const deepText = (n: { text?: string; children?: Array<{ text?: string; children?: unknown[] }> }): string =>
    n.text ?? (n.children ?? []).map((c) => deepText(c)).join("");
  const texts = (cells: Array<Array<{ text?: string; children?: Array<{ text?: string; children?: unknown[] }> }>>) =>
    cells.map((c) => c.map((n) => deepText(n)).join(""));

  it("parses header + delimiter + data rows, with alignment colons", () => {
    const md = "| name | age | note |\n|:-----|:----:|-----:|\n| amy | 3 | **x** |\n| bo | 44 | `y` |";
    const nodes = parseMarkdown(md);
    expect(nodes.length).toBe(1);
    const t = nodes[0] as {
      type: string;
      align: string[];
      header: Array<Array<{ text?: string; type: string }>>;
      rows: Array<Array<Array<{ text?: string; type: string }>>>;
    };
    expect(t.type).toBe("table");
    expect(t.align).toEqual(["left", "center", "right"]);
    expect(texts(t.header)).toEqual(["name", "age", "note"]);
    expect(texts(t.rows[0]!)).toEqual(["amy", "3", "x"]);
    expect(t.rows[0]![2]![0]!.type).toBe("strong"); // cell content goes through parseInline
    expect(t.rows[1]![2]![0]!.type).toBe("code");
  });

  it("works without leading/trailing pipes; header-only table has zero rows", () => {
    const nodes = parseMarkdown("a | b\n--- | ---");
    expect(nodes[0]).toMatchObject({ type: "table", align: ["", ""], rows: [] });
    expect(texts((nodes[0] as { header: Array<Array<{ text?: string }>> }).header)).toEqual(["a", "b"]);
  });

  it("escaped \\| stays inside its cell and resolves to a literal pipe", () => {
    const nodes = parseMarkdown("a \\| b | c\n--- | ---\n1 | 2");
    const t = nodes[0] as { header: Array<Array<{ text?: string }>> };
    expect(t.header.length).toBe(2);
    expect(texts(t.header)).toEqual(["a | b", "c"]);
  });

  it("ragged data rows follow GFM: extra cells truncated, missing cells padded empty", () => {
    const nodes = parseMarkdown("a | b | c\n--|--|--\n1 | 2\n1 | 2 | 3 | 4");
    const t = nodes[0] as { rows: Array<Array<Array<{ text?: string }>>> };
    expect(t.rows.length).toBe(2);
    expect(t.rows[0]!.length).toBe(3);
    expect(texts(t.rows[0]!)).toEqual(["1", "2", ""]);
    expect(texts(t.rows[1]!)).toEqual(["1", "2", "3"]);
  });

  it("malformed tables degrade to plain paragraphs, never throw", () => {
    for (const md of [
      "a | b\n---\n1 | 2", // delimiter row has no pipe
      "a | b\n--- | --- | ---\n1 | 2", // header/delimiter column count mismatch
      "a | b\n--- | x |\n1 | 2", // non-delimiter cell in the delimiter row
      "a | b\n| |\n1 | 2", // empty delimiter cell
    ]) {
      const nodes = parseMarkdown(md);
      expect(JSON.stringify(nodes), md).not.toContain('"table"');
      expect(nodes.every((n) => n.type === "paragraph")).toBe(true);
      expect(JSON.stringify(nodes)).toContain("a | b"); // source preserved as literal text
    }
  });

  it("table ends at a blank line or a pipe-less line", () => {
    const nodes = parseMarkdown("a|b\n--|--\n1|2\ntail\n\nnext");
    expect(nodes.map((n) => n.type)).toEqual(["table", "paragraph", "paragraph"]);
    const t = nodes[0] as { rows: unknown[] };
    expect(t.rows.length).toBe(1);
  });

  it("a single | or an all-empty row is not a table", () => {
    expect(JSON.stringify(parseMarkdown("|\n---"))).not.toContain('"table"');
  });
});

describe("blockquotes (parser level)", () => {
  it("aggregates consecutive > lines into one quote with a paragraph child", () => {
    const nodes = parseMarkdown("> hello\n> world");
    expect(nodes).toEqual([
      { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "hello\nworld" }] }] },
    ]);
  });

  it("nests quotes recursively (>>)", () => {
    const nodes = parseMarkdown("> > deep");
    const q1 = nodes[0] as {
      children: Array<{ type: string; children: Array<{ children?: Array<{ text?: string }> }> }>;
    };
    expect(q1.type).toBe("quote");
    const q2 = q1.children[0]!;
    expect(q2.type).toBe("quote");
    expect(q2.children[0]!.children?.[0]?.text).toBe("deep");
  });

  it("recurses into block parsing: lists and fenced code work inside quotes", () => {
    const list = parseMarkdown("> - a\n> - b")[0] as { children: Array<{ type: string; items: unknown[] }> };
    expect(list.children[0]!.type).toBe("list");
    expect(list.children[0]!.items.length).toBe(2);
    const code = parseMarkdown("> ```js\n> let x = 1\n> ```")[0] as {
      children: Array<{ type: string; lang: string; text: string }>;
    };
    expect(code.children[0]).toMatchObject({ type: "code_block", lang: "js", text: "let x = 1" });
  });

  it("tables parse inside quotes", () => {
    const q = parseMarkdown("> | a |\n> |---|\n> | 1 |")[0] as { children: Array<{ type: string }> };
    expect(q.children[0]!.type).toBe("table");
  });

  it("GFM lazy continuation: a bare paragraph line joins an open quote paragraph", () => {
    const nodes = parseMarkdown("> line one\nline two");
    expect(nodes.length).toBe(1);
    const q = nodes[0] as { children: Array<{ children: Array<{ text?: string }> }> };
    expect(q.children[0]!.children[0]!.text).toBe("line one\nline two");
  });

  it("lazy continuation never crosses a blank line or a new block start", () => {
    const blank = parseMarkdown("> a\n\n> b");
    expect(blank.map((n) => n.type)).toEqual(["quote", "quote"]);
    const listBreak = parseMarkdown("> para\n- item");
    expect(listBreak.map((n) => n.type)).toEqual(["quote", "list"]);
    const fenceBreak = parseMarkdown("> para\n```\nx\n```");
    expect(fenceBreak.map((n) => n.type)).toEqual(["quote", "code_block"]);
  });

  it("quote nesting is depth-capped: beyond the cap the markers stay literal text", () => {
    const nodes = parseMarkdown(`${">".repeat(20)} x`);
    expect(() => JSON.stringify(nodes)).not.toThrow();
    expect(JSON.stringify(nodes)).toContain("> x"); // innermost excess marker survives as text
  });
});

describe("strikethrough (parser level)", () => {
  it("~~x~~ pairs non-greedily and nests other inline marks", () => {
    const nodes = parseMarkdown("~~gone~~ and ~~**bold**~~ end");
    const kids = (
      nodes[0] as {
        children: Array<{ type: string; children?: Array<{ type: string; text?: string }>; text?: string }>;
      }
    ).children;
    expect(kids[0]).toEqual({ type: "del", children: [{ type: "text", text: "gone" }] });
    expect(kids[2]!.type).toBe("del");
    expect(kids[2]!.children?.[0]?.type).toBe("strong");
  });

  it("unclosed/space-flanked ~~ and single ~ stay literal", () => {
    const txt = (md: string) => JSON.stringify(parseMarkdown(md));
    expect(txt("~~open")).toContain("~~open");
    expect(txt("~~ open~~")).not.toContain('"del"');
    expect(txt("a ~~ b")).not.toContain('"del"');
    expect(txt("~single~")).not.toContain('"del"');
    expect(txt("a \\~~ b")).toContain("~~"); // escaped tilde pair stays literal
  });
});

describe("task list items (parser level)", () => {
  type ListNode = {
    type: string;
    ordered: boolean;
    items: Array<Array<{ text?: string }>>;
    checked?: (boolean | null)[];
  };
  const texts = (n: ListNode) => n.items.map((item) => item.map((x) => x.text ?? "").join(""));

  it("- [ ] / - [x] / - [X] strip the marker and record checked state", () => {
    const n = parseMarkdown("- [ ] todo\n- [x] done\n- [X] shipped")[0] as ListNode;
    expect(n.type).toBe("list");
    expect(n.checked).toEqual([false, true, true]);
    expect(texts(n)).toEqual(["todo", "done", "shipped"]);
  });

  it("mixed plain/task items keep a parallel checked array with nulls", () => {
    const n = parseMarkdown("- plain\n- [x] t")[0] as ListNode;
    expect(n.checked).toEqual([null, true]);
    expect(texts(n)).toEqual(["plain", "t"]);
  });

  it("no task marker ⇒ no checked key at all (plain lists unchanged)", () => {
    const n = parseMarkdown("- a\n- b")[0] as ListNode;
    expect("checked" in n).toBe(false);
  });

  it("ordered lists never parse task markers; marker without trailing space is literal", () => {
    const ol = parseMarkdown("1. [x] no")[0] as ListNode;
    expect(ol.ordered).toBe(true);
    expect("checked" in ol).toBe(false);
    expect(texts(ol)).toEqual(["[x] no"]);
    const tight = parseMarkdown("- [ ]nospace")[0] as ListNode;
    expect("checked" in tight).toBe(false);
    expect(texts(tight)).toEqual(["[ ]nospace"]);
  });

  it("task item text still goes through parseInline; continuation lines keep the state", () => {
    const n = parseMarkdown("- [x] **bold** step")[0] as ListNode;
    expect(n.checked).toEqual([true]);
    expect((n.items[0]![0] as { type: string }).type).toBe("strong");
    const cont = parseMarkdown("- [ ] a\n  cont")[0] as ListNode;
    expect(cont.checked).toEqual([false]);
    expect(texts(cont)).toEqual(["a\ncont"]);
  });
});

describe("parser performance", () => {
  it("stays linear: ~10k mixed lines plus one huge line parse fast (no catastrophic backtracking)", () => {
    const blocks: string[] = [];
    for (let k = 0; k < 2000; k++) {
      blocks.push("| a | b |\n|---|---|\n| 1 | 2 |\n> quote ~~gone~~ `code`");
    }
    const md = `${blocks.join("\n\n")}\n${"x|".repeat(25000)}`; // 8000 lines + separators + one 50k-char line
    const t0 = performance.now();
    const nodes = parseMarkdown(md);
    const ms = performance.now() - t0;
    expect(nodes.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
  });
});
