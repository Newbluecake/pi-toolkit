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
  });

  it("re-parses when the text prop changes (streaming tail updates)", async () => {
    const wrapper = mount(MarkdownView, { props: { text: "Hello" } });
    expect(wrapper.text()).toBe("Hello");
    await wrapper.setProps({ text: "Hello world" });
    expect(wrapper.text()).toBe("Hello world");
  });
});
