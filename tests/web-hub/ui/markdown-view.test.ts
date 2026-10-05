// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MarkdownView from "../../../src/web-hub/ui/src/components/transcript/MarkdownView.vue";

/**
 * `MarkdownView.vue` (vue-plan.md v2.1 §3.10/§5.2 — P4). Ports `tests/web-hub/web/markdown.test.ts`'s
 * XSS corpus to a mounted-component assertion: raw HTML in the source must never become a real
 * element (`v-html` is banned repo-wide and enforced separately by `source-scan.test.ts`; this
 * test proves the *rendered DOM* actually stays inert, not just that the source lacks the sink).
 */
describe("MarkdownView.vue", () => {
  it("never creates script/iframe/img/on*-bearing elements from raw HTML in the source", () => {
    const bad =
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> **<b>bold</b>**\n\n<iframe src="javascript:alert(2)"></iframe>\n\n```\n<script>x</script>\n```';
    const wrapper = mount(MarkdownView, { props: { text: bad } });
    for (const tag of ["script", "img", "b", "iframe"]) {
      expect(wrapper.find(tag).exists(), `unexpected <${tag}> in rendered output`).toBe(false);
    }
    expect(wrapper.findAll("[onerror]").length).toBe(0);
    // the raw markup survives as literal text (not silently dropped, not executed)
    expect(wrapper.text()).toContain("<script>alert(1)</script>");
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">');
  });

  it("javascript:/data:/vbscript: links render as literal text, never an <a>", () => {
    const wrapper = mount(MarkdownView, {
      props: { text: "[click](javascript:alert(1)) [d](data:text/html,<script>x</script>) [v](vbscript:x)" },
    });
    expect(wrapper.findAll("a").length).toBe(0);
    expect(wrapper.text()).toContain("[click](javascript:alert(1))");
  });

  it("rejects javascript:-scheme XSS bypass attempts (whitespace/entity/case tricks), never an <a>", () => {
    const corpus = [
      "[a](java\tscript:alert(1))",
      "[a](java\nscript:alert(1))",
      "[a](&#106;avascript:alert(1))",
      "[a](&#x6A;avascript:alert(1))",
      "[a]( javascript:alert(1))",
      "[a](JaVaScRiPt:alert(1))",
      "[a](data:text/html,<script>alert(1)</script>)",
      "[a](vbscript:msgbox(1))",
    ];
    for (const text of corpus) {
      const wrapper = mount(MarkdownView, { props: { text } });
      expect(wrapper.findAll("a").length, `unexpected <a> for: ${JSON.stringify(text)}`).toBe(0);
      expect(wrapper.findAll("[href]").length, `unexpected [href] for: ${JSON.stringify(text)}`).toBe(0);
      // the raw markup survives as literal text — never silently dropped, never executed
      const collapsed = wrapper.text().replace(/\s+/g, " ");
      const expected = text.replace(/\s+/g, " ");
      expect(collapsed, `raw markup not preserved as text for: ${JSON.stringify(text)}`).toContain(expected);
    }
  });

  it("http(s) links render as a real, safe <a>", () => {
    const wrapper = mount(MarkdownView, { props: { text: "[pi](https://example.com/x)" } });
    const a = wrapper.get("a");
    expect(a.attributes("href")).toBe("https://example.com/x");
    expect(a.attributes("rel")).toContain("noopener");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.text()).toBe("pi");
  });

  it("renders paragraphs, lists, headings (downgraded to h3+) and inline code/bold/italic", () => {
    const wrapper = mount(MarkdownView, {
      props: { text: "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two" },
    });
    expect(wrapper.find("h3").text()).toBe("Title");
    expect(wrapper.find("strong").text()).toBe("bold");
    expect(wrapper.find("em").text()).toBe("em");
    expect(wrapper.find("code").text()).toBe("code");
    expect(wrapper.findAll("li").map((li) => li.text())).toEqual(["one", "two"]);
    expect(wrapper.find("h1").exists()).toBe(false);
    expect(wrapper.find("h2").exists()).toBe(false);
  });

  it("fenced code blocks render through CodeBlock.vue (a .codeblock, not raw <pre> text)", () => {
    const wrapper = mount(MarkdownView, { props: { text: "```js\nconst x = 1;\n```" } });
    expect(wrapper.find(".codeblock").exists()).toBe(true);
    expect(wrapper.get("pre code").text()).toBe("const x = 1;");
    // axe scrollable-region-focusable: the horizontally scrollable <pre> must be keyboard-focusable.
    expect(wrapper.get(".codeblock pre").attributes("tabindex")).toBe("0");
  });

  it("re-parses when the text prop changes (streaming tail updates)", async () => {
    const wrapper = mount(MarkdownView, { props: { text: "Hello" } });
    expect(wrapper.text()).toBe("Hello");
    await wrapper.setProps({ text: "Hello world" });
    expect(wrapper.text()).toBe("Hello world");
  });
});

describe("MarkdownView.vue — whitelist extension (table/quote/del/task list)", () => {
  it("renders GFM tables with alignment classes inside a focusable horizontal-scroll wrapper", () => {
    const wrapper = mount(MarkdownView, {
      props: { text: "| name | age |\n|:-----|----:|\n| amy | 3 |" },
    });
    // axe scrollable-region-focusable: the horizontally scrollable wrapper must be focusable.
    expect(wrapper.get(".md-table-wrap").attributes("tabindex")).toBe("0");
    const ths = wrapper.findAll("th");
    expect(ths.map((t) => t.text())).toEqual(["name", "age"]);
    expect(ths[0]!.attributes("scope")).toBe("col");
    expect(ths[1]!.classes()).toContain("md-tr");
    expect(wrapper.findAll("td").map((t) => t.text())).toEqual(["amy", "3"]);
  });

  it("malformed tables render as literal text, never a <table>", () => {
    const wrapper = mount(MarkdownView, { props: { text: "| a | b |\n| --- | x |\n| 1 | 2 |" } });
    expect(wrapper.find("table").exists()).toBe(false);
    expect(wrapper.text()).toContain("| a | b |");
  });

  it("table cell HTML stays inert text (no element created)", () => {
    const wrapper = mount(MarkdownView, { props: { text: "| a |\n|---|\n| <img src=x onerror=alert(1)> |" } });
    expect(wrapper.find("table").exists()).toBe(true);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders blockquotes recursively (inline marks and nested lists)", () => {
    const wrapper = mount(MarkdownView, { props: { text: "> quoted **bold**\n> - item" } });
    const bq = wrapper.get("blockquote");
    expect(bq.get("strong").text()).toBe("bold");
    expect(bq.get("li").text()).toBe("item");
  });

  it("renders ~~strikethrough~~ as a <del> element", () => {
    const wrapper = mount(MarkdownView, { props: { text: "this is ~~gone~~ kept" } });
    expect(wrapper.get("del").text()).toBe("gone");
    expect(wrapper.text()).toContain("kept");
  });

  it("renders task items as read-only checkbox semantics, never an interactive <input>", () => {
    const wrapper = mount(MarkdownView, { props: { text: "- [ ] todo\n- [x] done\n- plain" } });
    const boxes = wrapper.findAll('[role="checkbox"]');
    expect(boxes.length).toBe(2);
    expect(boxes[0]!.attributes("aria-checked")).toBe("false");
    expect(boxes[1]!.attributes("aria-checked")).toBe("true");
    for (const b of boxes) expect(b.attributes("aria-disabled")).toBe("true");
    expect(wrapper.find("input").exists()).toBe(false);
    const lis = wrapper.findAll("li");
    expect(lis[0]!.classes()).toContain("md-task");
    expect(lis[2]!.classes()).not.toContain("md-task");
    expect(lis.map((li) => li.text())).toEqual(["☐todo", "☑done", "plain"]);
  });
});
